// Mempool front-runner.
//
// Strategy: subscribe to pending-tx hashes via a WebSocket RPC. When a tracked
// whale address sends a swap to a known router (PancakeSwap V3 on BSC, Uniswap
// V3 elsewhere), decode the call to find tokenOut, then submit our own buy of
// tokenOut with a gasPrice premium to land in the same block ahead of theirs.
//
// REALITY CHECK
// - Only works against whales using the public mempool. Anyone using
//   private RPC (BlockRazor, FlashBots Protect on ETH) is invisible to us.
// - On L2s with a private sequencer (Arbitrum, Base, Optimism) the mempool
//   is sequencer-internal; this module is essentially useless there.
// - Pro MEV bots have FPGA-tuned latency. We will lose to them on heavily
//   contested pairs. BSC is the realistic target — fewer pros, public mempool.
// - Honeypot tokens that you can't sell will rug you regardless of gas tricks.
//
// SAFETY KNOBS (env)
// - FRONTRUN_GAS_BOOST_BPS — how much above whale gas we bid (default 5000 = +50%)
// - FRONTRUN_MAX_GAS_GWEI — never bid above this absolute ceiling
// - FRONTRUN_MIN_BUY_USD / FRONTRUN_MAX_BUY_USD — value range we react to
// - FRONTRUN_MIN_LIQUIDITY_USD — skip illiquid pairs (rug risk)

import { Interface, JsonRpcProvider, Wallet, WebSocketProvider, getAddress, parseEther, formatGwei } from "ethers";
import { EventEmitter } from "node:events";
import type { Chain } from "../chains/registry";

// PancakeSwap V3 SmartRouter selectors (also matches Uniswap V3 SwapRouter02 — same shape).
const ROUTER_IFACE = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256)",
  // Universal router multicall (PancakeSwap also uses this) — covered loosely
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])"
]);

// Minimal ERC-20 for copy-buy
const ERC20_IFACE = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)"
]);

export type FrontrunConfig = {
  chain: Chain;
  wssUrl: string;
  privateKey: string;
  whaleAddresses: string[]; // lowercased, 0x-prefixed
  ourBuyUsd: number;
  ethPriceUsd: number;
  gasBoostBps: number; // e.g. 5000 = +50%
  maxGasGwei: number; // absolute cap
  minBuyUsd: number; // ignore tiny whale buys
  maxBuyUsd: number; // ignore megabuys (often coordinated dumps)
  cooldownMs: number;
  paperMode: boolean;
};

export type FrontrunEvent =
  | { kind: "watching"; address: string }
  | { kind: "candidate"; whale: string; tokenOut: string; whaleAmountEth: string; whaleGasGwei: string; pendingHash: string }
  | { kind: "skip"; reason: string; pendingHash?: string }
  | { kind: "fired"; pendingHash: string; ourHash: string; gasGwei: string; paper: boolean }
  | { kind: "error"; message: string };

export class MempoolFrontrunner extends EventEmitter {
  private cfg: FrontrunConfig;
  private ws: WebSocketProvider | null = null;
  private signer: Wallet | null = null;
  private whaleSet: Set<string>;
  private lastFiredAt = 0;
  private running = false;
  private executor: JsonRpcProvider; // submits via HTTPS (avoid blocking the WS)

  constructor(cfg: FrontrunConfig) {
    super();
    this.cfg = cfg;
    this.whaleSet = new Set(cfg.whaleAddresses.map((a) => getAddress(a).toLowerCase()));
    this.executor = new JsonRpcProvider(cfg.chain.rpcUrl, cfg.chain.id);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ws = new WebSocketProvider(this.cfg.wssUrl, this.cfg.chain.id);
    this.signer = new Wallet(this.cfg.privateKey, this.executor);

    for (const addr of this.whaleSet) this.emit("event", { kind: "watching", address: addr });

    // ethers v6 listens for "pending" events when the provider supports the
    // newPendingTransactions subscription. Each callback receives the tx hash.
    this.ws.on("pending", (hash: string) => this.onPending(hash).catch((e) => this.emit("event", { kind: "error", message: String(e) })));
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.ws) {
      await this.ws.removeAllListeners();
      await this.ws.destroy();
      this.ws = null;
    }
  }

  private async onPending(hash: string): Promise<void> {
    if (!this.ws || !this.signer) return;
    if (Date.now() - this.lastFiredAt < this.cfg.cooldownMs) return;

    const tx = await this.ws.getTransaction(hash);
    if (!tx || !tx.from || !tx.to) return;
    const from = tx.from.toLowerCase();
    if (!this.whaleSet.has(from)) return;
    if (getAddress(tx.to).toLowerCase() !== this.cfg.chain.uniswapRouter?.toLowerCase()) return;

    const decoded = decodeRouterCall(tx.data);
    if (!decoded) {
      this.emit("event", { kind: "skip", reason: "couldn't decode router call", pendingHash: hash });
      return;
    }
    const tokenOut = decoded.tokenOut;
    if (tokenOut.toLowerCase() === this.cfg.chain.weth?.toLowerCase()) {
      // Whale is selling for native — handled by the mirror-sell path elsewhere.
      this.emit("event", { kind: "skip", reason: "whale is selling, not buying", pendingHash: hash });
      return;
    }

    const whaleValueEth = Number(tx.value) / 1e18;
    const whaleUsd = whaleValueEth * this.cfg.ethPriceUsd;
    if (whaleUsd < this.cfg.minBuyUsd || whaleUsd > this.cfg.maxBuyUsd) {
      this.emit("event", { kind: "skip", reason: `whale buy $${whaleUsd.toFixed(0)} outside range`, pendingHash: hash });
      return;
    }

    const whaleGas = tx.gasPrice ?? tx.maxFeePerGas ?? 0n;
    if (whaleGas === 0n) return;
    const boosted = (whaleGas * BigInt(10_000 + this.cfg.gasBoostBps)) / 10_000n;
    const cap = BigInt(Math.floor(this.cfg.maxGasGwei * 1e9));
    const ourGas = boosted > cap ? cap : boosted;

    this.emit("event", {
      kind: "candidate",
      whale: from,
      tokenOut,
      whaleAmountEth: whaleValueEth.toFixed(6),
      whaleGasGwei: formatGwei(whaleGas),
      pendingHash: hash
    });

    if (this.cfg.paperMode) {
      this.emit("event", { kind: "fired", pendingHash: hash, ourHash: "PAPER", gasGwei: formatGwei(ourGas), paper: true });
      this.lastFiredAt = Date.now();
      return;
    }

    try {
      const ourAmountIn = parseEther((this.cfg.ourBuyUsd / Math.max(this.cfg.ethPriceUsd, 1)).toFixed(6));
      // Build exactInputSingle ourselves so we don't depend on whale's path encoding.
      const data = ROUTER_IFACE.encodeFunctionData("exactInputSingle", [
        {
          tokenIn: this.cfg.chain.weth!,
          tokenOut,
          fee: 3000,
          recipient: await this.signer.getAddress(),
          amountIn: ourAmountIn,
          amountOutMinimum: 0n, // intentional — we want the trade to land
          sqrtPriceLimitX96: 0n
        }
      ]);

      // First wrap WBNB (if our balance is in WBNB we can skip; here we send native value)
      // PancakeSwap V3 SmartRouter accepts native via msg.value when tokenIn=WETH and the call is wrapped in multicall — for simplicity we approximate by sending WETH directly. The user is expected to keep a WBNB balance ready for front-running.
      const ourTx = await this.signer.sendTransaction({
        to: this.cfg.chain.uniswapRouter!,
        data,
        gasPrice: ourGas,
        gasLimit: 350_000n
      });
      this.lastFiredAt = Date.now();
      this.emit("event", { kind: "fired", pendingHash: hash, ourHash: ourTx.hash, gasGwei: formatGwei(ourGas), paper: false });
    } catch (e) {
      this.emit("event", { kind: "error", message: `submit failed: ${String(e)}` });
    }
  }
}

function decodeRouterCall(data: string): { tokenOut: string } | null {
  if (!data || data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase();
  try {
    if (sel === ROUTER_IFACE.getFunction("exactInputSingle")!.selector) {
      const [args] = ROUTER_IFACE.decodeFunctionData("exactInputSingle", data) as unknown as [{ tokenOut: string }];
      return { tokenOut: args.tokenOut };
    }
    if (sel === ROUTER_IFACE.getFunction("exactInput")!.selector) {
      const [args] = ROUTER_IFACE.decodeFunctionData("exactInput", data) as unknown as [{ path: string }];
      // Path ends with the final tokenOut (last 20 bytes).
      const path = args.path.startsWith("0x") ? args.path.slice(2) : args.path;
      const tokenOut = "0x" + path.slice(path.length - 40);
      return { tokenOut };
    }
    if (sel === ROUTER_IFACE.getFunction("multicall")!.selector) {
      const [, calls] = ROUTER_IFACE.decodeFunctionData("multicall", data) as unknown as [bigint, string[]];
      // Recurse into the inner calls — usually the first wrap+swap.
      for (const inner of calls) {
        const r = decodeRouterCall(inner);
        if (r) return r;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Suppress lint on unused import (kept for future ERC-20 approve support in fired buys)
void ERC20_IFACE;
