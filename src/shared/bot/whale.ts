// Whale tracker: subscribes to ERC20 Transfer logs where `from` or `to` matches
// any tracked address. Emits events the bot can react to.

import { JsonRpcProvider, Interface, getAddress, formatUnits } from "ethers";
import { EventEmitter } from "node:events";

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20_IFACE = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
]);

export type WhaleEvent = {
  type: "buy" | "sell" | "transfer";
  whale: string;
  token: string;
  symbol?: string;
  amount: string;
  amountRaw: bigint;
  decimals?: number;
  txHash: string;
  blockNumber: number;
};

export class WhaleTracker extends EventEmitter {
  private addresses: Set<string>;
  private provider: JsonRpcProvider;
  private pollHandle: NodeJS.Timeout | null = null;
  private lastBlock = 0;
  private decimalsCache = new Map<string, { decimals: number; symbol: string }>();

  constructor(provider: JsonRpcProvider, addresses: string[]) {
    super();
    this.provider = provider;
    this.addresses = new Set(addresses.map((a) => getAddress(a).toLowerCase()));
  }

  async start(intervalMs = 12_000): Promise<void> {
    this.lastBlock = await this.provider.getBlockNumber();
    this.pollHandle = setInterval(() => {
      this.poll().catch((e) => this.emit("error", e));
    }, intervalMs);
  }

  stop(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = null;
  }

  private async poll(): Promise<void> {
    const head = await this.provider.getBlockNumber();
    if (head <= this.lastBlock) return;
    const fromBlock = this.lastBlock + 1;
    const toBlock = Math.min(head, fromBlock + 50); // cap range to avoid heavy reads
    this.lastBlock = toBlock;

    for (const addr of this.addresses) {
      const padded = "0x" + addr.slice(2).padStart(64, "0");
      const sentLogs = await this.provider.getLogs({
        fromBlock,
        toBlock,
        topics: [ERC20_TRANSFER_TOPIC, padded]
      });
      const recvLogs = await this.provider.getLogs({
        fromBlock,
        toBlock,
        topics: [ERC20_TRANSFER_TOPIC, null, padded]
      });

      for (const log of [...sentLogs, ...recvLogs]) {
        const parsed = ERC20_IFACE.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed) continue;
        const from = (parsed.args[0] as string).toLowerCase();
        const to = (parsed.args[1] as string).toLowerCase();
        const value = parsed.args[2] as bigint;
        const meta = await this.tokenMeta(log.address);
        const event: WhaleEvent = {
          type: from === addr ? "sell" : to === addr ? "buy" : "transfer",
          whale: addr,
          token: log.address,
          symbol: meta?.symbol,
          decimals: meta?.decimals,
          amount: meta ? formatUnits(value, meta.decimals) : value.toString(),
          amountRaw: value,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber
        };
        this.emit("event", event);
      }
    }
  }

  private async tokenMeta(token: string): Promise<{ decimals: number; symbol: string } | null> {
    if (this.decimalsCache.has(token)) return this.decimalsCache.get(token)!;
    try {
      const [decimalsHex, symbolHex] = await Promise.all([
        this.provider.call({ to: token, data: ERC20_IFACE.getFunction("decimals")!.selector }),
        this.provider.call({ to: token, data: ERC20_IFACE.getFunction("symbol")!.selector })
      ]);
      const decimals = Number(BigInt(decimalsHex));
      const symbol = ERC20_IFACE.decodeFunctionResult("symbol", symbolHex)[0] as string;
      const meta = { decimals, symbol };
      this.decimalsCache.set(token, meta);
      return meta;
    } catch {
      return null;
    }
  }
}
