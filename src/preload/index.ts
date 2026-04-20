import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc";

const api = {
  wallet: {
    list: () => ipcRenderer.invoke(IPC.walletList),
    create: (name: string, password: string) => ipcRenderer.invoke(IPC.walletCreate, { name, password }),
    importMnemonic: (name: string, phrase: string, password: string) =>
      ipcRenderer.invoke(IPC.walletImportMnemonic, { name, phrase, password }),
    importPrivateKey: (name: string, privateKey: string, password: string) =>
      ipcRenderer.invoke(IPC.walletImportPrivateKey, { name, privateKey, password }),
    delete: (id: string) => ipcRenderer.invoke(IPC.walletDelete, id),
    select: (id: string) => ipcRenderer.invoke(IPC.walletSelect, id),
    reveal: (id: string, password: string) => ipcRenderer.invoke(IPC.walletReveal, { id, password }),
    balance: (id: string) => ipcRenderer.invoke(IPC.walletGetBalance, id),
    send: (id: string, password: string, to: string, valueEth: string) =>
      ipcRenderer.invoke(IPC.walletSendNative, { id, password, to, valueEth })
  },
  chain: {
    list: () => ipcRenderer.invoke(IPC.chainList),
    add: (chain: { id: number; name: string; symbol: string; rpcUrl: string; explorerUrl: string }) =>
      ipcRenderer.invoke(IPC.chainAdd, chain),
    remove: (id: number) => ipcRenderer.invoke(IPC.chainRemove, id),
    select: (id: number) => ipcRenderer.invoke(IPC.chainSelect, id)
  },
  dapp: {
    open: (url: string) => ipcRenderer.invoke(IPC.dappOpen, url),
    hide: () => ipcRenderer.invoke("dapp:hide"),
    onPasswordRequest: (cb: (info: { method: string; address: string }) => void) => {
      const handler = (_e: unknown, info: { method: string; address: string }) => cb(info);
      ipcRenderer.on("dapp:password-request", handler);
      return () => ipcRenderer.removeListener("dapp:password-request", handler);
    },
    sendPassword: (pwd: string | null) => ipcRenderer.send("dapp:password-response", pwd),
    onChainSwitchRequest: (cb: (id: number) => void) => {
      const handler = (_e: unknown, id: number) => cb(id);
      ipcRenderer.on("dapp:request-chain-switch", handler);
      return () => ipcRenderer.removeListener("dapp:request-chain-switch", handler);
    }
  },
  bot: {
    start: (config: unknown) => ipcRenderer.invoke(IPC.botStart, config),
    stop: () => ipcRenderer.invoke(IPC.botStop),
    status: () => ipcRenderer.invoke(IPC.botStatus),
    onEvent: (cb: (e: unknown) => void) => {
      const handler = (_e: unknown, ev: unknown) => cb(ev);
      ipcRenderer.on(IPC.botEvent, handler);
      return () => ipcRenderer.removeListener(IPC.botEvent, handler);
    }
  }
};

contextBridge.exposeInMainWorld("walletApi", api);

export type WalletApi = typeof api;
