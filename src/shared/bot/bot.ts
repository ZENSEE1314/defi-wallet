import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { EventEmitter } from "node:events";
import { discover, type DiscoveredToken, type DiscoveryFilters } from "./discovery";
import { WhaleTracker, type WhaleEvent } from "./whale";
import { swap } from "./swap";
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
};

export type BotEvent =
  | { kind: "discovered"; token: DiscoveredToken }
  | { kind: "whale"; event: WhaleEvent }
  | { kind: "buy"; token: string; amountEth: string; hash: string; paper: boolean }
  | { kind: "sell"; token: string; reason: "profit" | "stop"; hash: string; paper: boolean }
  | { kind: "skip"; token: string; reason: string }
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
  }

  status(): { running: boolean; positions: Position[] } {
    return { running: this.running, positions: [...this.positions.values()] };
  }

  private async runDiscovery(): Promise<void> {
    const tokens = await discover(this.cfg.filters);
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

  private emitEvent(e: BotEvent): void {
    this.emit("event", e);
  }
}
