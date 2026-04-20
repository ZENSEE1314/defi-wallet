import { ipcMain, BrowserWindow } from "electron";
import { TradingBot, type BotConfig, type BotEvent } from "../shared/bot/bot";
import { IPC } from "../shared/ipc";
import { BUILTIN_CHAINS, findChain } from "../shared/chains/registry";
import { getState } from "./store";
import { unlockWallet, deriveSigner } from "../shared/wallet/keystore";

let bot: TradingBot | null = null;

export type StartBotReq = {
  walletId: string;
  password: string;
  chainId: number;
  filters: BotConfig["filters"];
  whaleAddresses: string[];
  autoBuyUsd: number;
  autoSellProfitPct: number;
  autoStopLossPct: number;
  slippageBps: number;
  ethPriceUsd: number;
  paperMode: boolean;
};

function broadcast(event: BotEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.botEvent, event);
  }
}

export function registerBotHandlers(): void {
  ipcMain.handle(IPC.botStart, async (_e, req: StartBotReq) => {
    if (bot) throw new Error("bot already running");
    const { wallets, customChains } = getState();
    const wallet = wallets.find((w) => w.id === req.walletId);
    if (!wallet) throw new Error("wallet not found");
    const chain = findChain([...BUILTIN_CHAINS, ...customChains], req.chainId);
    if (!chain) throw new Error("chain not found");

    const secret = unlockWallet(wallet, req.password);
    const signer = deriveSigner(secret, wallet.source);
    const privateKey = "privateKey" in signer ? signer.privateKey : (signer as { privateKey: string }).privateKey;

    bot = new TradingBot({
      chain,
      privateKey,
      filters: req.filters,
      whaleAddresses: req.whaleAddresses,
      autoBuyUsd: req.autoBuyUsd,
      autoSellProfitPct: req.autoSellProfitPct,
      autoStopLossPct: req.autoStopLossPct,
      slippageBps: req.slippageBps,
      ethPriceUsd: req.ethPriceUsd,
      paperMode: req.paperMode
    });
    bot.on("event", broadcast);
    await bot.start();
    return { running: true };
  });

  ipcMain.handle(IPC.botStop, async () => {
    if (!bot) return { running: false };
    await bot.stop();
    bot = null;
    return { running: false };
  });

  ipcMain.handle(IPC.botStatus, async () => {
    return bot ? bot.status() : { running: false, positions: [] };
  });
}
