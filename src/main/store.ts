import Store from "electron-store";
import { DEFAULT_STATE, type AppState } from "../shared/storage/schema";

const store = new Store<AppState>({
  name: "wallet-state",
  defaults: DEFAULT_STATE,
  clearInvalidConfig: false,
  fileExtension: "json"
});

export function getState(): AppState {
  return {
    wallets: store.get("wallets"),
    selectedWalletId: store.get("selectedWalletId"),
    customChains: store.get("customChains"),
    selectedChainId: store.get("selectedChainId")
  };
}

export function setState(patch: Partial<AppState>): void {
  for (const [k, v] of Object.entries(patch)) {
    store.set(k as keyof AppState, v as never);
  }
}
