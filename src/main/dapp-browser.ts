import { BrowserWindow, BrowserView, ipcMain, dialog } from "electron";
import path from "node:path";
import { JsonRpcProvider, parseEther } from "ethers";
import { IPC, type RpcRequest, type RpcResponse } from "../shared/ipc";
import { findChain } from "../shared/chains/registry";
import { BUILTIN_CHAINS } from "../shared/chains/registry";
import { getState } from "./store";
import { deriveSigner, unlockWallet } from "../shared/wallet/keystore";

let view: BrowserView | null = null;
let host: BrowserWindow | null = null;

const BROWSER_TOP_OFFSET = 96; // header height for tabs/url bar
const BROWSER_SIDE_OFFSET = 0;

export function attachDappBrowser(window: BrowserWindow): void {
  host = window;
  view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "../preload/dapp-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  view.setAutoResize({ width: true, height: true });
  positionView();
  window.on("resize", positionView);

  ipcMain.handle(IPC.dappOpen, async (_e, url: string) => {
    if (!view) return;
    if (!host?.getBrowserViews().includes(view)) host?.addBrowserView(view);
    positionView();
    await view.webContents.loadURL(url);
  });

  ipcMain.handle(IPC.dappRpcRequest, async (_e, req: RpcRequest): Promise<RpcResponse> => {
    return handleRpc(req);
  });

  ipcMain.handle("dapp:hide", () => {
    if (view && host?.getBrowserViews().includes(view)) host.removeBrowserView(view);
  });
}

function positionView(): void {
  if (!view || !host) return;
  const b = host.getContentBounds();
  view.setBounds({
    x: BROWSER_SIDE_OFFSET,
    y: BROWSER_TOP_OFFSET,
    width: b.width - BROWSER_SIDE_OFFSET * 2,
    height: b.height - BROWSER_TOP_OFFSET
  });
}

async function handleRpc(req: RpcRequest): Promise<RpcResponse> {
  const allChains = [...BUILTIN_CHAINS, ...getState().customChains.map((c) => ({ ...c, isCustom: true }))];
  const { wallets, selectedWalletId, selectedChainId } = getState();
  const wallet = wallets.find((w) => w.id === selectedWalletId);
  const chain = findChain(allChains, selectedChainId);
  if (!chain) return { error: { code: -32602, message: "no active chain" } };

  switch (req.method) {
    case "eth_chainId":
      return { result: `0x${chain.id.toString(16)}` };

    case "eth_accounts":
    case "eth_requestAccounts": {
      if (!wallet) return { error: { code: 4100, message: "no wallet selected" } };
      return { result: [wallet.address] };
    }

    case "wallet_switchEthereumChain": {
      const target = (req.params?.[0] as { chainId: string } | undefined)?.chainId;
      if (!target) return { error: { code: -32602, message: "missing chainId" } };
      const desired = Number.parseInt(target, 16);
      const found = findChain(allChains, desired);
      if (!found) return { error: { code: 4902, message: `unknown chain ${desired}. Add it in Networks first.` } };
      // Tell the renderer to switch — it owns persistence and notifications.
      host?.webContents.send("dapp:request-chain-switch", desired);
      return { result: null };
    }

    case "personal_sign":
    case "eth_sign":
    case "eth_sendTransaction": {
      if (!wallet) return { error: { code: 4100, message: "no wallet selected" } };
      const password = await promptPassword(req.method, wallet.address);
      if (!password) return { error: { code: 4001, message: "user rejected" } };
      try {
        const secret = unlockWallet(wallet, password);
        const signer = deriveSigner(secret, wallet.source).connect(new JsonRpcProvider(chain.rpcUrl, chain.id));
        if (req.method === "eth_sendTransaction") {
          const tx = req.params?.[0] as { to: string; value?: string; data?: string; gas?: string };
          const sent = await signer.sendTransaction({
            to: tx.to,
            value: tx.value ? BigInt(tx.value) : 0n,
            data: tx.data,
            gasLimit: tx.gas ? BigInt(tx.gas) : undefined
          });
          return { result: sent.hash };
        }
        const message = req.params?.[0] as string;
        const sig = await signer.signMessage(typeof message === "string" && message.startsWith("0x") ? Buffer.from(message.slice(2), "hex") : message);
        return { result: sig };
      } catch (e: unknown) {
        return { error: { code: -32000, message: e instanceof Error ? e.message : "signing failed" } };
      }
    }

    default: {
      // Fall through to read-only RPC against the active chain.
      try {
        const provider = new JsonRpcProvider(chain.rpcUrl, chain.id);
        const result = await provider.send(req.method, req.params ?? []);
        return { result };
      } catch (e: unknown) {
        return { error: { code: -32603, message: e instanceof Error ? e.message : "rpc error" } };
      }
    }
  }
}

async function promptPassword(method: string, address: string): Promise<string | null> {
  if (!host) return null;
  // Render confirmation in the main window via the renderer; it returns the password.
  const ok = await dialog.showMessageBox(host, {
    type: "warning",
    title: "Confirm signature request",
    message: `A dApp wants to call ${method} from ${address}. Approve?`,
    buttons: ["Reject", "Approve"],
    defaultId: 0,
    cancelId: 0
  });
  if (ok.response !== 1) return null;
  // Password collection is delegated to the renderer for proper UX.
  return await new Promise<string | null>((resolve) => {
    ipcMain.once("dapp:password-response", (_e, pwd: string | null) => resolve(pwd));
    host?.webContents.send("dapp:password-request", { method, address });
  });
}

export function getDappWebContentsId(): number | null {
  return view?.webContents.id ?? null;
}
