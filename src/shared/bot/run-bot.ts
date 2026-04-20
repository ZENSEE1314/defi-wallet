// Standalone bot runner — useful for headless operation outside the Electron app.
// Run with: npm run bot

import "dotenv/config";
import { TradingBot } from "./bot";
import { BotApi } from "./api";
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
    mirrorSell: process.env.MIRROR_SELL === "true",
    momentum: process.env.MOMENTUM_ENABLED === "true"
      ? {
          topN: Number(process.env.MOMENTUM_TOP_N ?? "30"),
          buyUsd: Number(process.env.MOMENTUM_BUY_USD ?? "8"),
          thresh1mPct: Number(process.env.MOMENTUM_THRESH_1M_PCT ?? "1.5"),
          thresh5mPct: Number(process.env.MOMENTUM_THRESH_5M_PCT ?? "4"),
          takeProfitPct: Number(process.env.MOMENTUM_TP_PCT ?? "10"),
          stopLossPct: Number(process.env.MOMENTUM_SL_PCT ?? "3"),
          timeStopMinutes: Number(process.env.MOMENTUM_TIME_STOP_MIN ?? "30"),
          minLiquidityUsd: Number(process.env.MOMENTUM_MIN_LIQ_USD ?? "100000"),
          maxConcurrentPositions: Number(process.env.MOMENTUM_MAX_POS ?? "3"),
          pollIntervalMs: Number(process.env.MOMENTUM_POLL_MS ?? "30000")
        }
      : undefined,
    frontrun: process.env.FRONTRUN_ENABLED === "true" && process.env.WSS_RPC_URL
      ? {
          wssUrl: process.env.WSS_RPC_URL,
          gasBoostBps: Number(process.env.FRONTRUN_GAS_BOOST_BPS ?? "5000"),
          maxGasGwei: Number(process.env.FRONTRUN_MAX_GAS_GWEI ?? "20"),
          minBuyUsd: Number(process.env.FRONTRUN_MIN_BUY_USD ?? "500"),
          maxBuyUsd: Number(process.env.FRONTRUN_MAX_BUY_USD ?? "50000"),
          cooldownMs: Number(process.env.FRONTRUN_COOLDOWN_MS ?? "10000")
        }
      : undefined,
    slippageBps: Number(process.env.SLIPPAGE_BPS ?? "100"),
    ethPriceUsd: 3000, // TODO: pull from price feed
    paperMode
  });

  bot.on("event", (e) => console.log(JSON.stringify(e)));
  console.log(JSON.stringify({ kind: "boot", chain: chain.name, paperMode, filters: { minLiq: process.env.DISCOVERY_MIN_LIQUIDITY_USD ?? "50000", minVol: process.env.DISCOVERY_MIN_VOLUME_24H_USD ?? "100000", maxAge: process.env.DISCOVERY_MAX_AGE_HOURS ?? "72" } }));
  await bot.start();
  setInterval(() => console.log(JSON.stringify({ kind: "heartbeat", at: new Date().toISOString(), positions: bot.status().positions.length })), 30_000);

  // HTTP control plane — only enabled if BOT_API_TOKEN is set, so the bot
  // doesn't accidentally expose itself unauthenticated.
  const apiToken = process.env.BOT_API_TOKEN;
  if (apiToken) {
    const api = new BotApi(bot, apiToken, {
      paperMode,
      momentumEnabled: process.env.MOMENTUM_ENABLED === "true",
      frontrunEnabled: process.env.FRONTRUN_ENABLED === "true"
    });
    const port = Number(process.env.PORT ?? process.env.BOT_API_PORT ?? "8080");
    api.listen(port);
  } else {
    console.log(JSON.stringify({ kind: "api-disabled", reason: "BOT_API_TOKEN not set" }));
  }

  process.on("SIGINT", async () => {
    await bot.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
