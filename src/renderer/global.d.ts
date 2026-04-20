import type { WalletApi } from "../preload";

declare global {
  interface Window {
    walletApi: WalletApi;
  }
}

export {};
