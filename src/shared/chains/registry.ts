export type Chain = {
  id: number;
  name: string;
  symbol: string;
  rpcUrl: string;
  explorerUrl: string;
  isCustom?: boolean;
  uniswapRouter?: string;
  weth?: string;
};

export const BUILTIN_CHAINS: Chain[] = [
  {
    id: 1,
    name: "Ethereum",
    symbol: "ETH",
    rpcUrl: "https://eth.llamarpc.com",
    explorerUrl: "https://etherscan.io",
    uniswapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
  },
  {
    id: 8453,
    name: "Base",
    symbol: "ETH",
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    uniswapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
    weth: "0x4200000000000000000000000000000000000006"
  },
  {
    id: 42161,
    name: "Arbitrum One",
    symbol: "ETH",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
    uniswapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
  },
  {
    id: 10,
    name: "Optimism",
    symbol: "ETH",
    rpcUrl: "https://mainnet.optimism.io",
    explorerUrl: "https://optimistic.etherscan.io",
    uniswapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    weth: "0x4200000000000000000000000000000000000006"
  },
  {
    id: 137,
    name: "Polygon",
    symbol: "MATIC",
    rpcUrl: "https://polygon-rpc.com",
    explorerUrl: "https://polygonscan.com",
    uniswapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    weth: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
  },
  {
    id: 56,
    name: "BNB Smart Chain",
    symbol: "BNB",
    rpcUrl: "https://bsc-dataseed.bnbchain.org",
    explorerUrl: "https://bscscan.com",
    // Uniswap V3 SwapRouter02 on BSC. The bot's discovery uses Dexscreener "bsc";
    // wrap with WBNB for native swaps.
    uniswapRouter: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
  },
  {
    id: 11155111,
    name: "Sepolia (testnet)",
    symbol: "ETH",
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorerUrl: "https://sepolia.etherscan.io"
  }
];

export function findChain(chains: Chain[], id: number): Chain | undefined {
  return chains.find((c) => c.id === id);
}
