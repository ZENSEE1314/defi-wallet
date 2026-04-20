import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { EventEmitter } from "node:events";
import { discover, type DiscoveredToken, type DiscoveryFilters } from "./discovery";
import { WhaleTracker, type WhaleEvent } from "./whale";
import { swap } from "./swap";
import { MempoolFrontrunner, type FrontrunEvent } from "./frontrun";
import { MomentumScanner, type MomentumEvent } from "./momentum";
import type { Chain } from "../chains/registry";

export type BotConfig = {
  chain: Chain;
  privateKey: string;
  filters: DiscoveryFilters;
  whaleAddresses: string[];
  autoBuyUsd: number;
  autoSellProfitPct: number;
  autoStopLossPct: number;
  slippageBps: number;
  ethPriceUsd: number; // injected — bot avoids price-feed work for now
  paperMode: boolean;
  discoverIntervalMs?: number;
  // Optional mempool front-run mode (BSC/ETH only — L2s have private sequencers).
  frontrun?: {
    wssUrl: string;
    gasBoostBps: number;
    maxGasGwei: number;
    minBuyUsd: number;
    maxBuyUsd: number;
    cooldownMs: number;
  };
  // Mirror exit: when a tracked whale sells a token, sell our position too.
  mirrorSell?: boolean;
  // Top-volume momentum scanner — designed for small capital (~$100) on BSC.
  momentum?: {
    topN: number;
    buyUsd: number;
    thresh1mPct: number;
    thresh5mPct: number;
    takeProfitPct: number;
    stopLossPct: number;
    timeStopMinutes: number;
    minLiquidityUsd: number;
    maxConcurrentPositions: number;
    pollIntervalMs: number;
  };
};

export type BotEvent =
  | { kind: "discovered"; token: DiscoveredToken }
  | { kind: "whale"; event: WhaleEvent }
  | { kind: "buy"; token: string; amountEth: string; hash: string; paper: boolean }
  | { kind: "sell"; token: string; reason: "profit" | "stop" | "whale-exit"; hash: string; paper: boolean }
  | { kind: "skip"; token: string; reason: string }
  | { kind: "frontrun"; event: FrontrunEvent }
  | { kind: "momentum"; event: MomentumEvent }
  | { kind: "error"; message: string };

type Position = {
  token: string;
  symbol: string;
  entryPriceUsd: number;
  amountEth: bigint;
  acquiredAt: number;
};

export class TradingBot extends EventEmitter {
  private cfg: BotConfig;
  private provider: JsonRpcProvider;
  private signer: Wallet;
  private whale: WhaleTracker | null = null;
  private frontrunner: MempoolFrontrunner | null = null;
  private momentum: MomentumScanner | null = null;
  private discoverHandle: NodeJS.Timeout | null = null;
  private positions = new Map<string, Position>();
  private seen = new Set<string>();
  private running = false;

  constructor(cfg: BotConfig) {
    super();
    this.cfg = cfg;
    this.provider = new JsonRpcProvider(cfg.chain.rpcUrl, cfg.chain.id);
    this.signer = new Wallet(cfg.privateKey, this.provider);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.cfg.whaleAddresses.length > 0) {
      this.whale = new WhaleTracker(this.provider, this.cfg.whaleAddresses);
      this.whale.on("event", (e) => this.handleWhale(e));
      this.whale.on("error", (err) => this.emitEvent({ kind: "error", message: String(err) }));
      await this.whale.start();
    }

    if (this.cfg.frontrun && this.cfg.whaleAddresses.length > 0) {
      this.frontrunner = new MempoolFrontrunner({
        chain: this.cfg.chain,
        wssUrl: this.cfg.frontrun.wssUrl,
        privateKey: this.cfg.privateKey,
        whaleAddresses: this.cfg.whaleAddresses,
        ourBuyUsd: this.cfg.autoBuyUsd,
        ethPriceUsd: this.cfg.ethPriceUsd,
        gasBoostBps: this.cfg.frontrun.gasBoostBps,
        maxGasGwei: this.cfg.frontrun.maxGasGwei,
        minBuyUsd: this.cfg.frontrun.minBuyUsd,
        maxBuyUsd: this.cfg.frontrun.maxBuyUsd,
        cooldownMs: this.cfg.frontrun.cooldownMs,
        paperMode: this.cfg.paperMode
      });
      this.frontrunner.on("event", (e) => this.emitEvent({ kind: "frontrun", event: e }));
      await this.frontrunner.start();
    }

    if (this.cfg.momentum) {
      const dexChain = ({ 1: "ethereum", 8453: "base", 42161: "arbitrum", 10: "optimism", 137: "polygon", 56: "bsc" } as const)[this.cfg.chain.id as 1 | 8453 | 42161 | 10 | 137 | 56] ?? "ethereum";
      this.momentum = new MomentumScanner({
        chain: this.cfg.chain,
        signer: this.signer,
        provider: this.provider,
        dexChain,
        topN: this.cfg.momentum.topN,
        buyUsd: this.cfg.momentum.buyUsd,
        ethPriceUsd: this.cfg.ethPriceUsd,
        thresh1mPct: this.cfg.momentum.thresh1mPct,
        thresh5mPct: this.cfg.momentum.thresh5mPct,
        takeProfitPct: this.cfg.momentum.takeProfitPct,
        stopLossPct: this.cfg.momentum.stopLossPct,
        timeStopMinutes: this.cfg.momentum.timeStopMinutes,
        minLiquidityUsd: this.cfg.momentum.minLiquidityUsd,
        maxConcurrentPositions: this.cfg.momentum.maxConcurrentPositions,
        slippageBps: this.cfg.slippageBps,
        pollIntervalMs: this.cfg.momentum.pollIntervalMs,
        paperMode: this.cfg.paperMode
      });
      this.momentum.on("event", (e) => this.emitEvent({ kind: "momentum", event: e }));
      await this.momentum.start();
    }

    const interval = this.cfg.discoverIntervalMs ?? 60_000;
    const tick = () => this.runDiscovery().catch((e) => this.emitEvent({ kind: "error", message: String(e) }));
    tick();
    this.discoverHandle = setInterval(tick, interval);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.discoverHandle) clearInterval(this.discoverHandle);
    this.discoverHandle = null;
    this.whale?.stop();
    this.whale = null;
    await this.frontrunner?.stop();
    this.frontrunner = null;
    this.momentum?.stop();
    this.momentum = null;
  }

  status(): { running: boolean; positions: Position[] } {
    return { running: this.running, positions: [...this.positions.values()] };
  }

  private async runDiscovery(): Promise<void> {
    const tokens = await discover(this.cfg.filters);
    this.emitEvent({ kind: "skip", token: "(discovery)", reason: `${tokens.length} candidates passed filters` });
    for (const t of tokens.slice(0, 10)) {
      if (this.seen.has(t.baseToken.address.toLowerCase())) continue;
      this.seen.add(t.baseToken.address.toLowerCase());
      this.emitEvent({ kind: "discovered", token: t });

      if (!this.cfg.chain.uniswapRouter || !this.cfg.chain.weth) {
        this.emitEvent({ kind: "skip", token: t.baseToken.address, reason: "chain has no uniswap router configured" });
        continue;
      }

      const ethAmount = this.cfg.autoBuyUsd / Math.max(this.cfg.ethPriceUsd, 1);
      const amountIn = parseEther(ethAmount.toFixed(6));

      try {
        if (this.cfg.paperMode) {
          this.emitEvent({ kind: "buy", token: t.baseToken.address, amountEth: ethAmount.toFixed(6), hash: "PAPER", paper: true });
        } else {
          const { hash } = await swap({
            router: this.cfg.chain.uniswapRouter,
            weth: this.cfg.chain.weth,
            signer: this.signer,
            provider: this.provider,
            tokenIn: this.cfg.chain.weth,
            tokenOut: t.baseToken.address,
            amountIn,
            slippageBps: this.cfg.slippageBps,
            isNativeIn: true
          });
          this.emitEvent({ kind: "buy", token: t.baseToken.address, amountEth: ethAmount.toFixed(6), hash, paper: false });
        }
        this.positions.set(t.baseToken.address, {
          token: t.baseToken.address,
          symbol: t.baseToken.symbol,
          entryPriceUsd: t.priceUsd,
          amountEth: amountIn,
          acquiredAt: Date.now()
        });
      } catch (e) {
        this.emitEvent({ kind: "error", message: `buy failed: ${String(e)}` });
      }
    }

    await this.evaluatePositions(tokens);
  }

  private async evaluatePositions(latest: DiscoveredToken[]): Promise<void> {
    const priceMap = new Map(latest.map((t) => [t.baseToken.address.toLowerCase(), t.priceUsd]));
    for (const [token, pos] of this.positions) {
      const price = priceMap.get(token.toLowerCase());
      if (!price) continue;
      const changePct = ((price - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      const reason: "profit" | "stop" | null =
        changePct >= this.cfg.autoSellProfitPct ? "profit" : changePct <= -this.cfg.autoStopLossPct ? "stop" : null;
      if (!reason) continue;

      try {
        if (this.cfg.paperMode) {
          this.emitEvent({ kind: "sell", token, reason, hash: "PAPER", paper: true });
        } else {
          // Need actual token balance here; v1 sells the whole bag.
          const { tokenBalance } = await import("./swap");
          const bal = await tokenBalance(this.provider, token, await this.signer.getAddress());
          if (bal.raw === 0n) {
            this.positions.delete(token);
            continue;
          }
          const { hash } = await swap({
            router: this.cfg.chain.uniswapRouter!,
            weth: this.cfg.chain.weth!,
            signer: this.signer,
            provider: this.provider,
            tokenIn: token,
            tokenOut: this.cfg.chain.weth!,
            amountIn: bal.raw,
            slippageBps: this.cfg.slippageBps,
            isNativeOut: true
          });
          this.emitEvent({ kind: "sell", token, reason, hash, paper: false });
        }
        this.positions.delete(token);
      } catch (e) {
        this.emitEvent({ kind: "error", message: `sell failed: ${String(e)}` });
      }
    }
  }

  private async handleWhale(e: WhaleEvent): Promise<void> {
    this.emitEvent({ kind: "whale", event: e });

    // Mirror exit: whale dumping a token we hold? Sell ours too.
    if (e.type === "sell" && this.cfg.mirrorSell && this.positions.has(e.token)) {
      await this.exitPosition(e.token, "whale-exit");
      return;
    }

    if (e.type !== "buy") return;
    if (this.seen.has(e.token.toLowerCase())) return;
    if (!this.cfg.chain.uniswapRouter || !this.cfg.chain.weth) return;

    this.seen.add(e.token.toLowerCase());
    const ethAmount = this.cfg.autoBuyUsd / Math.max(this.cfg.ethPriceUsd, 1);
    const amountIn = parseEther(ethAmount.toFixed(6));

    try {
      if (this.cfg.paperMode) {
        this.emitEvent({ kind: "buy", token: e.token, amountEth: ethAmount.toFixed(6), hash: "PAPER-WHALE", paper: true });
      } else {
        const { hash } = await swap({
          router: this.cfg.chain.uniswapRouter,
          weth: this.cfg.chain.weth,
          signer: this.signer,
          provider: this.provider,
          tokenIn: this.cfg.chain.weth,
          tokenOut: e.token,
          amountIn,
          slippageBps: this.cfg.slippageBps,
          isNativeIn: true
        });
        this.emitEvent({ kind: "buy", token: e.token, amountEth: ethAmount.toFixed(6), hash, paper: false });
      }
      this.positions.set(e.token, {
        token: e.token,
        symbol: e.symbol ?? "?",
        entryPriceUsd: 0,
        amountEth: amountIn,
        acquiredAt: Date.now()
      });
    } catch (err) {
      this.emitEvent({ kind: "error", message: `whale-follow buy failed: ${String(err)}` });
    }
  }

  private async exitPosition(token: string, reason: "profit" | "stop" | "whale-exit"): Promise<void> {
    if (!this.cfg.chain.uniswapRouter || !this.cfg.chain.weth) return;
    try {
      if (this.cfg.paperMode) {
        this.emitEvent({ kind: "sell", token, reason, hash: "PAPER", paper: true });
      } else {
        const { tokenBalance } = await import("./swap");
        const bal = await tokenBalance(this.provider, token, await this.signer.getAddress());
        if (bal.raw === 0n) {
          this.positions.delete(token);
          return;
        }
        const { hash } = await swap({
          router: this.cfg.chain.uniswapRouter,
          weth: this.cfg.chain.weth,
          signer: this.signer,
          provider: this.provider,
          tokenIn: token,
          tokenOut: this.cfg.chain.weth,
          amountIn: bal.raw,
          slippageBps: this.cfg.slippageBps,
          isNativeOut: true
        });
        this.emitEvent({ kind: "sell", token, reason, hash, paper: false });
      }
      this.positions.delete(token);
    } catch (err) {
      this.emitEvent({ kind: "error", message: `exit (${reason}) failed: ${String(err)}` });
    }
  }

  private emitEvent(e: BotEvent): void {
    this.emit("event", e);
  }
}
