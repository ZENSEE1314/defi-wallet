// Standalone bot runner — useful for headless operation outside the Electron app.
// Run with: npm run bot

import "dotenv/config";
import { TradingBot } from "./bot";
import { BUILTIN_CHAINS, findChain } from "../chains/registry";

async function main(): Promise<void> {
  const chainId = Number(process.env.BOT_CHAIN_ID ?? "1");
  const chain = findChain(BUILTIN_CHAINS, chainId);
  if (!chain) throw new Error(`unknown chain ${chainId}`);
  if (!process.env.BOT_PRIVATE_KEY) throw new Error("BOT_PRIVATE_KEY required");

  const bot = new TradingBot({
    chain: { ...chain, rpcUrl: process.env.BOT_RPC_URL ?? chain.rpcUrl },
    privateKey: process.env.BOT_PRIVATE_KEY,
    filters: {
      chain: chain.name.toLowerCase().includes("base") ? "base" : "ethereum",
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
    paperMode: process.env.PAPER_MODE !== "false"
  });

  bot.on("event", (e) => console.log(JSON.stringify(e)));
  await bot.start();

  process.on("SIGINT", async () => {
    await bot.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
