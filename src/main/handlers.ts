import { ipcMain } from "electron";
import { formatEther, parseEther } from "ethers";
import { IPC, type AddChainReq, type BalanceRes, type ChainListRes, type CreateWalletReq, type ImportMnemonicReq, type ImportPrivateKeyReq, type RevealReq, type SendNativeReq, type WalletListRes } from "../shared/ipc";
import { BUILTIN_CHAINS, findChain, type Chain } from "../shared/chains/registry";
import { createMnemonicWallet, deriveSigner, importMnemonicWallet, importPrivateKeyWallet, unlockWallet, type WalletRecord } from "../shared/wallet/keystore";
import { getState, setState } from "./store";
import { getProvider } from "./rpc";

function allChains(): Chain[] {
  const { customChains } = getState();
  return [...BUILTIN_CHAINS, ...customChains.map((c) => ({ ...c, isCustom: true }))];
}

function publicWallet(w: WalletRecord): WalletRecord {
  return w;
}

export function registerHandlers(): void {
  ipcMain.handle(IPC.walletList, async (): Promise<WalletListRes> => {
    const { wallets, selectedWalletId } = getState();
    return { wallets: wallets.map(publicWallet), selectedId: selectedWalletId };
  });

  ipcMain.handle(IPC.walletCreate, async (_e, req: CreateWalletReq): Promise<WalletListRes> => {
    const w = createMnemonicWallet(req.name, req.password);
    const { wallets } = getState();
    const next = [...wallets, { id: w.id, name: w.name, address: w.address, createdAt: w.createdAt, source: w.source, encrypted: w.encrypted }];
    setState({ wallets: next, selectedWalletId: w.id });
    return { wallets: next, selectedId: w.id };
  });

  ipcMain.handle(IPC.walletImportMnemonic, async (_e, req: ImportMnemonicReq): Promise<WalletListRes> => {
    const w = importMnemonicWallet(req.name, req.phrase, req.password);
    const { wallets } = getState();
    const next = [...wallets, { id: w.id, name: w.name, address: w.address, createdAt: w.createdAt, source: w.source, encrypted: w.encrypted }];
    setState({ wallets: next, selectedWalletId: w.id });
    return { wallets: next, selectedId: w.id };
  });

  ipcMain.handle(IPC.walletImportPrivateKey, async (_e, req: ImportPrivateKeyReq): Promise<WalletListRes> => {
    const w = importPrivateKeyWallet(req.name, req.privateKey, req.password);
    const { wallets } = getState();
    const next = [...wallets, { id: w.id, name: w.name, address: w.address, createdAt: w.createdAt, source: w.source, encrypted: w.encrypted }];
    setState({ wallets: next, selectedWalletId: w.id });
    return { wallets: next, selectedId: w.id };
  });

  ipcMain.handle(IPC.walletDelete, async (_e, id: string): Promise<WalletListRes> => {
    const { wallets, selectedWalletId } = getState();
    const next = wallets.filter((w) => w.id !== id);
    const nextSel = selectedWalletId === id ? (next[0]?.id ?? null) : selectedWalletId;
    setState({ wallets: next, selectedWalletId: nextSel });
    return { wallets: next, selectedId: nextSel };
  });

  ipcMain.handle(IPC.walletSelect, async (_e, id: string): Promise<WalletListRes> => {
    setState({ selectedWalletId: id });
    const { wallets } = getState();
    return { wallets, selectedId: id };
  });

  ipcMain.handle(IPC.walletReveal, async (_e, req: RevealReq): Promise<{ secret: string }> => {
    const { wallets } = getState();
    const w = wallets.find((x) => x.id === req.id);
    if (!w) throw new Error("wallet not found");
    return { secret: unlockWallet(w, req.password) };
  });

  ipcMain.handle(IPC.walletGetBalance, async (_e, id: string): Promise<BalanceRes> => {
    const { wallets, selectedChainId } = getState();
    const w = wallets.find((x) => x.id === id);
    if (!w) throw new Error("wallet not found");
    const chain = findChain(allChains(), selectedChainId);
    if (!chain) throw new Error("chain not found");
    const wei = await getProvider(chain).getBalance(w.address);
    return { wei: wei.toString(), eth: formatEther(wei) };
  });

  ipcMain.handle(IPC.walletSendNative, async (_e, req: SendNativeReq): Promise<{ hash: string }> => {
    const { wallets, selectedChainId } = getState();
    const w = wallets.find((x) => x.id === req.id);
    if (!w) throw new Error("wallet not found");
    const chain = findChain(allChains(), selectedChainId);
    if (!chain) throw new Error("chain not found");
    const secret = unlockWallet(w, req.password);
    const signer = deriveSigner(secret, w.source).connect(getProvider(chain));
    const tx = await signer.sendTransaction({ to: req.to, value: parseEther(req.valueEth) });
    return { hash: tx.hash };
  });

  ipcMain.handle(IPC.chainList, async (): Promise<ChainListRes> => {
    const { selectedChainId } = getState();
    return { chains: allChains(), selectedId: selectedChainId };
  });

  ipcMain.handle(IPC.chainAdd, async (_e, req: AddChainReq): Promise<ChainListRes> => {
    const { customChains, selectedChainId } = getState();
    if (allChains().some((c) => c.id === req.id)) throw new Error(`chain ${req.id} already exists`);
    const next = [...customChains, { ...req, isCustom: true }];
    setState({ customChains: next });
    return { chains: [...BUILTIN_CHAINS, ...next], selectedId: selectedChainId };
  });

  ipcMain.handle(IPC.chainRemove, async (_e, id: number): Promise<ChainListRes> => {
    const { customChains, selectedChainId } = getState();
    const next = customChains.filter((c) => c.id !== id);
    const nextSel = selectedChainId === id ? 1 : selectedChainId;
    setState({ customChains: next, selectedChainId: nextSel });
    return { chains: [...BUILTIN_CHAINS, ...next], selectedId: nextSel };
  });

  ipcMain.handle(IPC.chainSelect, async (_e, id: number): Promise<ChainListRes> => {
    setState({ selectedChainId: id });
    return { chains: allChains(), selectedId: id };
  });
}
