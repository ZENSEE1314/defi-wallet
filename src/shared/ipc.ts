import type { WalletRecord } from "./wallet/keystore";
import type { Chain } from "./chains/registry";

export const IPC = {
  walletList: "wallet:list",
  walletCreate: "wallet:create",
  walletImportMnemonic: "wallet:import-mnemonic",
  walletImportPrivateKey: "wallet:import-pk",
  walletDelete: "wallet:delete",
  walletSelect: "wallet:select",
  walletReveal: "wallet:reveal",
  walletGetBalance: "wallet:balance",
  walletSendNative: "wallet:send-native",

  chainList: "chain:list",
  chainAdd: "chain:add",
  chainRemove: "chain:remove",
  chainSelect: "chain:select",

  dappOpen: "dapp:open",
  dappRpcRequest: "dapp:rpc-request",

  botStart: "bot:start",
  botStop: "bot:stop",
  botStatus: "bot:status",
  botEvent: "bot:event"
} as const;

export type CreateWalletReq = { name: string; password: string };
export type ImportMnemonicReq = { name: string; phrase: string; password: string };
export type ImportPrivateKeyReq = { name: string; privateKey: string; password: string };
export type RevealReq = { id: string; password: string };
export type SendNativeReq = { id: string; password: string; to: string; valueEth: string };
export type AddChainReq = Omit<Chain, "isCustom">;

export type WalletListRes = { wallets: WalletRecord[]; selectedId: string | null };
export type ChainListRes = { chains: Chain[]; selectedId: number };
export type BalanceRes = { wei: string; eth: string };

export type RpcRequest = { method: string; params?: unknown[] };
export type RpcResponse = { result?: unknown; error?: { code: number; message: string } };
