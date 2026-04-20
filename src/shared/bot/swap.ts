// Uniswap V3 single-hop swap helper. Wraps native ETH via WETH automatically.

import { Contract, Wallet, parseUnits, type JsonRpcProvider } from "ethers";

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)"
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)"
];
const WETH_ABI = ["function deposit() payable", "function withdraw(uint256 amount)"];

export type SwapParams = {
  router: string;
  weth: string;
  signer: Wallet;
  provider: JsonRpcProvider;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: number; // e.g. 100 = 1%
  fee?: 500 | 3000 | 10_000;
  isNativeIn?: boolean;
  isNativeOut?: boolean;
};

export async function swap(p: SwapParams): Promise<{ hash: string }> {
  const fee = p.fee ?? 3000;
  const router = new Contract(p.router, ROUTER_ABI, p.signer);

  let actualTokenIn = p.tokenIn;
  let value = 0n;

  if (p.isNativeIn) {
    // Wrap ETH → WETH first.
    const weth = new Contract(p.weth, WETH_ABI, p.signer);
    const wrap = await weth.deposit({ value: p.amountIn });
    await wrap.wait();
    actualTokenIn = p.weth;
  }

  // Approve router if needed.
  const erc20 = new Contract(actualTokenIn, ERC20_ABI, p.signer);
  const allowance: bigint = await erc20.allowance(await p.signer.getAddress(), p.router);
  if (allowance < p.amountIn) {
    const approveTx = await erc20.approve(p.router, (1n << 256n) - 1n);
    await approveTx.wait();
  }

  // amountOutMinimum=0 with explicit slippage check would need a quote first.
  // For safety we use slippageBps relative to amountIn as a coarse floor (caller should
  // override with a quoted value when possible).
  const amountOutMinimum = (p.amountIn * BigInt(10_000 - p.slippageBps)) / 10_000n;

  const tx = await router.exactInputSingle(
    {
      tokenIn: actualTokenIn,
      tokenOut: p.isNativeOut ? p.weth : p.tokenOut,
      fee,
      recipient: await p.signer.getAddress(),
      amountIn: p.amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    },
    { value }
  );
  const receipt = await tx.wait();
  return { hash: receipt!.hash };
}

export async function nativeBalance(provider: JsonRpcProvider, address: string): Promise<bigint> {
  return await provider.getBalance(address);
}

export async function tokenBalance(provider: JsonRpcProvider, token: string, address: string): Promise<{ raw: bigint; decimals: number }> {
  const erc20 = new Contract(token, ERC20_ABI, provider);
  const [raw, decimals] = await Promise.all([erc20.balanceOf(address) as Promise<bigint>, erc20.decimals() as Promise<bigint>]);
  return { raw, decimals: Number(decimals) };
}

export function toUnits(amount: string, decimals: number): bigint {
  return parseUnits(amount, decimals);
}
