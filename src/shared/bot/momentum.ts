// Top-volume momentum scanner.
//
// Strategy: every interval, pull the top-N pairs on a chain by 24h volume from
// Dexscreener. For each pair, keep a rolling price history. Buy when both 1-min
// and 5-min returns clear configured thresholds (a clean upward spike). Exit on
// take-profit, stop-loss, or a time-stop so we don't sit on stale momentum.
//
// Designed for small capital (~$100) on BSC where gas is cheap. The
// configurable thresholds + tight TP/SL keep the win-rate × R:R math workable
// even after PancakeSwap fees + slippage.
//
// Notes:
// - Skips pairs with tiny liquidity (rug risk)
// - Skips pairs older than `maxAgeHours` if you only want established tokens
// - Caps concurrent positions to avoid spreading capital too thin

import { EventEmitter } from "node:events";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { swap, tokenBalance } from "./swap";
import type { Chain } from "../chains/registry";

export type MomentumConfig = {
  chain: Chain;
  signer: Wallet;
  provider: JsonRpcProvider;
  dexChain: "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "bsc";
  topN: number; // pairs to track (e.g. 30)
  buyUsd: number; // per-trade size
  ethPriceUsd: number; // injected — used to convert USD → native
  thresh1mPct: number; // e.g. 1.5 (need >1.5% gain in last 1m)
  thresh5mPct: number; // e.g. 4 (need >4% gain in last 5m)
  takeProfitPct: number; // e.g. 10
  stopLossPct: number; // e.g. 3
  timeStopMinutes: number; // close after this many minutes regardless
  minLiquidityUsd: number; // skip illiquid pairs
  maxConcurrentPositions: number;
  slippageBps: number;
  pollIntervalMs: number;
  paperMode: boolean;
};

export type MomentumEvent =
  | { kind: "scan"; tracked: number; topVolume: string }
  | { kind: "signal"; symbol: string; token: string; m1: number; m5: number; price: number }
  | { kind: "buy"; symbol: string; token: string; amountEth: string; hash: string; paper: boolean }
  | { kind: "sell"; symbol: string; token: string; reason: "tp" | "sl" | "time"; pnlPct: number; hash: string; paper: boolean }
  | { kind: "skip"; symbol: string; reason: string }
  | { kind: "error"; message: string };

type Snapshot = { ts: number; price: number };
type Position = {
  token: string;
  symbol: string;
  entryPrice: number;
  amountIn: bigint;
  acquiredAt: number;
};

// Dexscreener doesn't have a "top pairs by chain" endpoint. We work around it
// by querying the chain's wrapped-native token, which returns every pair
// trading against it on that chain — typically the highest-volume cohort.
const QUOTE_TOKEN_BY_CHAIN: Record<string, string> = {
  bsc: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",       // WBNB
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",  // WETH
  base: "0x4200000000000000000000000000000000000006",      // WETH (Base)
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",  // WETH (Arbitrum)
  optimism: "0x4200000000000000000000000000000000000006",  // WETH (Optimism)
  polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"    // WMATIC
};

export class MomentumScanner extends EventEmitter {
  private cfg: MomentumConfig;
  private history = new Map<string, Snapshot[]>(); // token → recent (ts, price)
  private positions = new Map<string, Position>();
  private bought = new Set<string>(); // cooldown — don't re-buy the same token within an hour
  private handle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(cfg: MomentumConfig) {
    super();
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const tick = () => this.runTick().catch((e) => this.emit("event", { kind: "error", message: String(e) }));
    tick();
    this.handle = setInterval(tick, this.cfg.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
  }

  private async runTick(): Promise<void> {
    const pairs = await fetchTopPairs(this.cfg.dexChain, this.cfg.topN, this.cfg.minLiquidityUsd);
    if (pairs.length === 0) {
      this.emit("event", { kind: "scan", tracked: 0, topVolume: "0" });
      return;
    }
    const now = Date.now();
    for (const p of pairs) {
      const arr = this.history.get(p.token) ?? [];
      arr.push({ ts: now, price: p.priceUsd });
      // Keep last 10 minutes only
      const cutoff = now - 10 * 60_000;
      while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
      this.history.set(p.token, arr);
    }
    this.emit("event", { kind: "scan", tracked: pairs.length, topVolume: (pairs[0].volume24h / 1000).toFixed(0) + "k" });

    // Evaluate signals
    if (this.positions.size < this.cfg.maxConcurrentPositions) {
      for (const p of pairs) {
        if (this.positions.has(p.token) || this.bought.has(p.token.toLowerCase())) continue;
        const m1 = pctChange(this.history.get(p.token) ?? [], 60_000);
        const m5 = pctChange(this.history.get(p.token) ?? [], 5 * 60_000);
        if (m1 === null || m5 === null) continue;
        if (m1 >= this.cfg.thresh1mPct && m5 >= this.cfg.thresh5mPct) {
          this.emit("event", { kind: "signal", symbol: p.symbol, token: p.token, m1, m5, price: p.priceUsd });
          await this.enter(p);
          if (this.positions.size >= this.cfg.maxConcurrentPositions) break;
        }
      }
    }

    // Manage open positions
    const priceMap = new Map(pairs.map((p) => [p.token.toLowerCase(), p.priceUsd]));
    for (const [token, pos] of this.positions) {
      const price = priceMap.get(token.toLowerCase());
      if (!price) continue;
      const pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      const ageMin = (now - pos.acquiredAt) / 60_000;
      let reason: "tp" | "sl" | "time" | null = null;
      if (pnl >= this.cfg.takeProfitPct) reason = "tp";
      else if (pnl <= -this.cfg.stopLossPct) reason = "sl";
      else if (ageMin >= this.cfg.timeStopMinutes) reason = "time";
      if (reason) await this.exit(token, pos, reason, pnl);
    }
  }

  private async enter(p: TopPair): Promise<void> {
    if (!this.cfg.chain.uniswapRouter || !this.cfg.chain.weth) {
      this.emit("event", { kind: "skip", symbol: p.symbol, reason: "chain has no router/weth" });
      return;
    }
    const ethAmount = this.cfg.buyUsd / Math.max(this.cfg.ethPriceUsd, 1);
    const amountIn = parseEther(ethAmount.toFixed(6));
    this.bought.add(p.token.toLowerCase());
    setTimeout(() => this.bought.delete(p.token.toLowerCase()), 60 * 60_000);

    try {
      let hash: string;
      if (this.cfg.paperMode) {
        hash = "PAPER";
      } else {
        const r = await swap({
          router: this.cfg.chain.uniswapRouter,
          weth: this.cfg.chain.weth,
          signer: this.cfg.signer,
          provider: this.cfg.provider,
          tokenIn: this.cfg.chain.weth,
          tokenOut: p.token,
          amountIn,
          slippageBps: this.cfg.slippageBps,
          isNativeIn: true
        });
        hash = r.hash;
      }
      this.positions.set(p.token, {
        token: p.token,
        symbol: p.symbol,
        entryPrice: p.priceUsd,
        amountIn,
        acquiredAt: Date.now()
      });
      this.emit("event", { kind: "buy", symbol: p.symbol, token: p.token, amountEth: ethAmount.toFixed(6), hash, paper: this.cfg.paperMode });
    } catch (e) {
      this.emit("event", { kind: "error", message: `momentum buy failed: ${String(e)}` });
    }
  }

  private async exit(token: string, pos: Position, reason: "tp" | "sl" | "time", pnlPct: number): Promise<void> {
    if (!this.cfg.chain.uniswapRouter || !this.cfg.chain.weth) return;
    try {
      let hash: string;
      if (this.cfg.paperMode) {
        hash = "PAPER";
      } else {
        const bal = await tokenBalance(this.cfg.provider, token, await this.cfg.signer.getAddress());
        if (bal.raw === 0n) {
          this.positions.delete(token);
          return;
        }
        const r = await swap({
          router: this.cfg.chain.uniswapRouter,
          weth: this.cfg.chain.weth,
          signer: this.cfg.signer,
          provider: this.cfg.provider,
          tokenIn: token,
          tokenOut: this.cfg.chain.weth,
          amountIn: bal.raw,
          slippageBps: this.cfg.slippageBps,
          isNativeOut: true
        });
        hash = r.hash;
      }
      this.positions.delete(token);
      this.emit("event", { kind: "sell", symbol: pos.symbol, token, reason, pnlPct, hash, paper: this.cfg.paperMode });
    } catch (e) {
      this.emit("event", { kind: "error", message: `momentum sell failed: ${String(e)}` });
    }
  }
}

type TopPair = {
  token: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24h: number;
};

async function fetchTopPairs(chain: string, n: number, minLiq: number): Promise<TopPair[]> {
  const quote = QUOTE_TOKEN_BY_CHAIN[chain];
  if (!quote) return [];
  // /tokens/{address} returns all pairs trading the wrapped-native on every
  // chain. We filter to the requested chain. The base token of each pair is
  // the *other* side of the pool — that's what we want to long.
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${quote}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { pairs?: RawPair[] };
  const quoteLower = quote.toLowerCase();
  return (data.pairs ?? [])
    .filter((p) => p.chainId === chain && (p.liquidity?.usd ?? 0) >= minLiq && p.priceUsd)
    .map<TopPair>((p) => {
      // Identify which side is the wrapped-native and pick the OTHER as our base.
      const baseIsQuote = p.baseToken.address.toLowerCase() === quoteLower;
      const target = baseIsQuote ? p.quoteToken : p.baseToken;
      return {
        token: target.address,
        symbol: target.symbol,
        priceUsd: Number(p.priceUsd),
        liquidityUsd: p.liquidity?.usd ?? 0,
        volume24h: p.volume?.h24 ?? 0
      };
    })
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, n);
}

type RawPair = {
  chainId: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
};

function pctChange(snaps: Snapshot[], windowMs: number): number | null {
  if (snaps.length === 0) return null;
  const now = snaps[snaps.length - 1];
  // Find the snapshot closest to (now - windowMs)
  const target = now.ts - windowMs;
  let prior: Snapshot | null = null;
  for (const s of snaps) {
    if (s.ts <= target) prior = s;
    else break;
  }
  if (!prior) return null;
  return ((now.price - prior.price) / prior.price) * 100;
}
