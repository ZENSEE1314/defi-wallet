import { contextBridge, ipcRenderer } from "electron";

// EIP-1193 provider injected into every dApp page loaded inside the BrowserView.
type Listener = (...args: unknown[]) => void;

class InjectedProvider {
  isMetaMask = true;
  isDeFiWallet = true;
  private listeners = new Map<string, Set<Listener>>();
  private connected = false;

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    const res = await ipcRenderer.invoke("dapp:rpc-request", args);
    if (res.error) {
      const err = new Error(res.error.message);
      (err as Error & { code?: number }).code = res.error.code;
      throw err;
    }
    if (!this.connected && (args.method === "eth_requestAccounts" || args.method === "eth_accounts")) {
      this.connected = true;
      this.emit("connect", { chainId: await this.request({ method: "eth_chainId" }) });
    }
    return res.result;
  }

  on(event: string, fn: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }

  removeListener(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }
}

const provider = new InjectedProvider();

ipcRenderer.on("dapp:chain-changed", (_e, chainIdHex: string) => {
  provider.emit("chainChanged", chainIdHex);
});

ipcRenderer.on("dapp:accounts-changed", (_e, accounts: string[]) => {
  provider.emit("accountsChanged", accounts);
});

contextBridge.exposeInMainWorld("ethereum", provider);
