import { JsonRpcProvider } from "ethers";
import type { Chain } from "../shared/chains/registry";

const cache = new Map<number, JsonRpcProvider>();

export function getProvider(chain: Chain): JsonRpcProvider {
  let p = cache.get(chain.id);
  if (!p) {
    p = new JsonRpcProvider(chain.rpcUrl, chain.id);
    cache.set(chain.id, p);
  }
  return p;
}

export function clearProvider(chainId: number): void {
  cache.delete(chainId);
}
