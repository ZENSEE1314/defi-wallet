import type { WalletRecord } from "../wallet/keystore";
import type { Chain } from "../chains/registry";

export type AppState = {
  wallets: WalletRecord[];
  selectedWalletId: string | null;
  customChains: Chain[];
  selectedChainId: number;
};

export const DEFAULT_STATE: AppState = {
  wallets: [],
  selectedWalletId: null,
  customChains: [],
  selectedChainId: 1
};
