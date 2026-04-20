// Token discovery via Dexscreener public API. Filters new pairs by liquidity, volume, and age.

export type DiscoveredToken = {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  ageHours: number;
  url: string;
};

export type DiscoveryFilters = {
  chain: "ethereum" | "base" | "arbitrum" | "optimism" | "polygon";
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxAgeHours: number;
};

const DEXSCREENER_NEW = "https://api.dexscreener.com/latest/dex/search?q=";

export async function discover(filters: DiscoveryFilters): Promise<DiscoveredToken[]> {
  // Dexscreener's "search" endpoint with the chain name returns recent pairs.
  const res = await fetch(`${DEXSCREENER_NEW}${filters.chain}`);
  if (!res.ok) throw new Error(`dexscreener: ${res.status}`);
  const data = (await res.json()) as { pairs?: RawPair[] };
  const now = Date.now();
  return (data.pairs ?? [])
    .filter((p) => p.chainId === filters.chain)
    .map<DiscoveredToken | null>((p) => {
      const liquidityUsd = p.liquidity?.usd ?? 0;
      const volume24hUsd = p.volume?.h24 ?? 0;
      const priceUsd = Number.parseFloat(p.priceUsd ?? "0");
      const ageHours = p.pairCreatedAt ? (now - p.pairCreatedAt) / 3_600_000 : Number.POSITIVE_INFINITY;
      if (liquidityUsd < filters.minLiquidityUsd) return null;
      if (volume24hUsd < filters.minVolume24hUsd) return null;
      if (ageHours > filters.maxAgeHours) return null;
      return {
        chainId: p.chainId,
        pairAddress: p.pairAddress,
        baseToken: p.baseToken,
        priceUsd,
        liquidityUsd,
        volume24hUsd,
        ageHours,
        url: p.url
      };
    })
    .filter((x): x is DiscoveredToken => x !== null)
    .sort((a, b) => b.volume24hUsd / Math.max(b.liquidityUsd, 1) - a.volume24hUsd / Math.max(a.liquidityUsd, 1));
}

type RawPair = {
  chainId: string;
  pairAddress: string;
  url: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
};
