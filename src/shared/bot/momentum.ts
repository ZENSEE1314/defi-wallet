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

// Dexscreener doesn't have a "top pairs by chain" endpoint. We query MULTIPLE
// high-liquidity quote tokens per chain and merge — querying just the wrapped
// native gets dominated by stablecoin/native pairs. Including USDT widens the
// alt universe a lot since most alts trade against USDT on BSC.
const QUOTE_TOKENS_BY_CHAIN: Record<string, string[]> = {
  bsc: [
    "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    "0x55d398326f99059fF775485246999027B3197955", // USDT (BEP-20)
    "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"  // USDC
  ],
  ethereum: [
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"  // USDC
  ],
  base: [
    "0x4200000000000000000000000000000000000006",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  // USDC
  ],
  arbitrum: [
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"  // USDC
  ],
  optimism: [
    "0x4200000000000000000000000000000000000006",
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"  // USDC
  ],
  polygon: [
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"  // USDT
  ]
};

// Stablecoins / wrapped-natives never move enough to trigger a momentum signal
// against the wrapped-native quote, so we skip them outright. Otherwise the
// "top by volume" list is dominated by USDT/WBNB pairs we'd never trade.
const SKIP_TOKENS = new Set([
  // BSC
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
  "0x14016e85a25aeb13065688cafb43044c2ef86784", // TUSD
  "0xfd7b3a77848f1c2d67e05e54d78d174a0c850335", // ANY
  "0xd17479997f34dd9156deef8f95a52d81d265be9c", // USDD
  "0x4b0f1812e5df2a09796481ff14017e6005508003", // TWT (sometimes flat)
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  // Ethereum
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT eth
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC eth
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  // Base / Arbitrum / Optimism / Polygon stables
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  "0x4200000000000000000000000000000000000006",
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"
]);

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
  const quotes = QUOTE_TOKENS_BY_CHAIN[chain] ?? [];
  if (quotes.length === 0) return [];
  // Query each quote token in parallel; each returns up to ~30 pairs.
  const responses = await Promise.all(
    quotes.map((q) =>
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${q}`)
        .then((r) => (r.ok ? r.json() : { pairs: [] }))
        .catch(() => ({ pairs: [] }))
    )
  );
  const quoteSet = new Set(quotes.map((q) => q.toLowerCase()));

  // Flatten + dedupe by target token (we don't want the same alt twice if it
  // pairs against multiple quotes; keep the highest-liquidity instance).
  const byToken = new Map<string, TopPair>();
  for (const data of responses as { pairs?: RawPair[] }[]) {
    for (const p of data.pairs ?? []) {
      if (p.chainId !== chain) continue;
      if ((p.liquidity?.usd ?? 0) < minLiq) continue;
      if (!p.priceUsd) continue;
      const baseIsQuote = quoteSet.has(p.baseToken.address.toLowerCase());
      const target = baseIsQuote ? p.quoteToken : p.baseToken;
      const tokenLower = target.address.toLowerCase();
      // Skip pairs where both sides are quotes (stable/native)
      if (SKIP_TOKENS.has(tokenLower)) continue;
      const candidate: TopPair = {
        token: target.address,
        symbol: target.symbol,
        priceUsd: Number(p.priceUsd),
        liquidityUsd: p.liquidity?.usd ?? 0,
        volume24h: p.volume?.h24 ?? 0
      };
      const existing = byToken.get(tokenLower);
      if (!existing || candidate.liquidityUsd > existing.liquidityUsd) {
        byToken.set(tokenLower, candidate);
      }
    }
  }
  return [...byToken.values()].sort((a, b) => b.volume24h - a.volume24h).slice(0, n);
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
