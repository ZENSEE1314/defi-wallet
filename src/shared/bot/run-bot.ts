// Standalone bot runner — useful for headless operation outside the Electron app.
// Run with: npm run bot

import "dotenv/config";
import { TradingBot } from "./bot";
import { BUILTIN_CHAINS, findChain } from "../chains/registry";

async function main(): Promise<void> {
  const chainId = Number(process.env.BOT_CHAIN_ID ?? "1");
  const chain = findChain(BUILTIN_CHAINS, chainId);
  if (!chain) throw new Error(`unknown chain ${chainId}`);
  const paperMode = process.env.PAPER_MODE !== "false";
  if (!process.env.BOT_PRIVATE_KEY && !paperMode) {
    throw new Error("BOT_PRIVATE_KEY required when PAPER_MODE=false");
  }
  // Paper mode never sends transactions, so a throwaway random key is fine.
  const privateKey =
    process.env.BOT_PRIVATE_KEY ??
    "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("");

  const bot = new TradingBot({
    chain: { ...chain, rpcUrl: process.env.BOT_RPC_URL ?? chain.rpcUrl },
    privateKey,
    filters: {
      chain: ({ 1: "ethereum", 8453: "base", 42161: "arbitrum", 10: "optimism", 137: "polygon", 56: "bsc" } as const)[chain.id as 1 | 8453 | 42161 | 10 | 137 | 56] ?? "ethereum",
      minLiquidityUsd: Number(process.env.DISCOVERY_MIN_LIQUIDITY_USD ?? "50000"),
      minVolume24hUsd: Number(process.env.DISCOVERY_MIN_VOLUME_24H_USD ?? "100000"),
      maxAgeHours: Number(process.env.DISCOVERY_MAX_AGE_HOURS ?? "72")
    },
    whaleAddresses: (process.env.WHALE_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    autoBuyUsd: Number(process.env.AUTO_BUY_USD ?? "50"),
    autoSellProfitPct: Number(process.env.AUTO_SELL_PROFIT_PCT ?? "50"),
    autoStopLossPct: Number(process.env.AUTO_STOP_LOSS_PCT ?? "20"),
    slippageBps: Number(process.env.SLIPPAGE_BPS ?? "100"),
    ethPriceUsd: 3000, // TODO: pull from price feed
    paperMode
  });

  bot.on("event", (e) => console.log(JSON.stringify(e)));
  console.log(JSON.stringify({ kind: "boot", chain: chain.name, paperMode, filters: { minLiq: process.env.DISCOVERY_MIN_LIQUIDITY_USD ?? "50000", minVol: process.env.DISCOVERY_MIN_VOLUME_24H_USD ?? "100000", maxAge: process.env.DISCOVERY_MAX_AGE_HOURS ?? "72" } }));
  await bot.start();
  setInterval(() => console.log(JSON.stringify({ kind: "heartbeat", at: new Date().toISOString(), positions: bot.status().positions.length })), 30_000);

  process.on("SIGINT", async () => {
    await bot.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
