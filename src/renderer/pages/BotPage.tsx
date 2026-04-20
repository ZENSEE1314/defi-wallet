import { useEffect, useRef, useState } from "react";
import type { WalletRecord } from "@shared/wallet/keystore";

type BotEvent =
  | { kind: "discovered"; token: { baseToken: { symbol: string; address: string }; priceUsd: number; liquidityUsd: number; volume24hUsd: number } }
  | { kind: "whale"; event: { whale: string; type: string; symbol?: string; amount: string; txHash: string } }
  | { kind: "buy"; token: string; amountEth: string; hash: string; paper: boolean }
  | { kind: "sell"; token: string; reason: string; hash: string; paper: boolean }
  | { kind: "skip"; token: string; reason: string }
  | { kind: "error"; message: string };

const CHAIN_TO_DEX = { 1: "ethereum", 8453: "base", 42161: "arbitrum", 10: "optimism", 137: "polygon", 56: "bsc" } as const;

export function BotPage(): JSX.Element {
  const [wallets, setWallets] = useState<WalletRecord[]>([]);
  const [chainId, setChainId] = useState(1);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [running, setRunning] = useState(false);
  const [paperMode, setPaperMode] = useState(true);
  const [events, setEvents] = useState<BotEvent[]>([]);
  const [cfg, setCfg] = useState({
    minLiquidityUsd: 50_000,
    minVolume24hUsd: 100_000,
    maxAgeHours: 72,
    autoBuyUsd: 50,
    autoSellProfitPct: 50,
    autoStopLossPct: 20,
    slippageBps: 100,
    ethPriceUsd: 3000,
    whaleAddresses: ""
  });
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.walletApi.wallet.list().then((r) => {
      setWallets(r.wallets);
      setWalletId(r.selectedId);
    });
    window.walletApi.chain.list().then((r) => setChainId(r.selectedId));
    window.walletApi.bot.status().then((s) => setRunning((s as { running: boolean }).running));
    return window.walletApi.bot.onEvent((e) => {
      setEvents((prev) => [e as BotEvent, ...prev].slice(0, 200));
    });
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [events]);

  async function startBot(): Promise<void> {
    if (!walletId || !password) { alert("Pick a wallet and enter password"); return; }
    const dexChain = CHAIN_TO_DEX[chainId as keyof typeof CHAIN_TO_DEX];
    if (!dexChain) { alert("Discovery only supports the chains in CHAIN_TO_DEX."); return; }
    try {
      await window.walletApi.bot.start({
        walletId,
        password,
        chainId,
        filters: { chain: dexChain, minLiquidityUsd: cfg.minLiquidityUsd, minVolume24hUsd: cfg.minVolume24hUsd, maxAgeHours: cfg.maxAgeHours },
        whaleAddresses: cfg.whaleAddresses.split(",").map((s) => s.trim()).filter(Boolean),
        autoBuyUsd: cfg.autoBuyUsd,
        autoSellProfitPct: cfg.autoSellProfitPct,
        autoStopLossPct: cfg.autoStopLossPct,
        slippageBps: cfg.slippageBps,
        ethPriceUsd: cfg.ethPriceUsd,
        paperMode
      });
      setRunning(true);
      setPassword("");
    } catch (e) {
      alert(`Start failed: ${(e as Error).message}`);
    }
  }

  async function stopBot(): Promise<void> {
    await window.walletApi.bot.stop();
    setRunning(false);
  }

  return (
    <>
      <h2>Trading Bot</h2>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <span className={`badge ${running ? "ok" : "warn"}`}>{running ? "RUNNING" : "STOPPED"}</span>
          <span className={`badge ${paperMode ? "ok" : "warn"}`}>{paperMode ? "PAPER MODE" : "LIVE — REAL FUNDS"}</span>
        </div>

        <div className="col">
          <div className="row">
            <div>
              <label>Wallet</label>
              <select value={walletId ?? ""} onChange={(e) => setWalletId(e.target.value)} disabled={running}>
                <option value="">Select…</option>
                {wallets.map((w) => <option key={w.id} value={w.id}>{w.name} — {w.address.slice(0, 8)}…</option>)}
              </select>
            </div>
            <div>
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={running} />
            </div>
          </div>

          <div className="row">
            <div><label>Min liquidity (USD)</label><input type="number" value={cfg.minLiquidityUsd} onChange={(e) => setCfg({ ...cfg, minLiquidityUsd: Number(e.target.value) })} disabled={running} /></div>
            <div><label>Min 24h vol (USD)</label><input type="number" value={cfg.minVolume24hUsd} onChange={(e) => setCfg({ ...cfg, minVolume24hUsd: Number(e.target.value) })} disabled={running} /></div>
            <div><label>Max age (h)</label><input type="number" value={cfg.maxAgeHours} onChange={(e) => setCfg({ ...cfg, maxAgeHours: Number(e.target.value) })} disabled={running} /></div>
          </div>

          <div className="row">
            <div><label>Auto-buy size (USD)</label><input type="number" value={cfg.autoBuyUsd} onChange={(e) => setCfg({ ...cfg, autoBuyUsd: Number(e.target.value) })} disabled={running} /></div>
            <div><label>Take-profit %</label><input type="number" value={cfg.autoSellProfitPct} onChange={(e) => setCfg({ ...cfg, autoSellProfitPct: Number(e.target.value) })} disabled={running} /></div>
            <div><label>Stop-loss %</label><input type="number" value={cfg.autoStopLossPct} onChange={(e) => setCfg({ ...cfg, autoStopLossPct: Number(e.target.value) })} disabled={running} /></div>
            <div><label>Slippage (bps)</label><input type="number" value={cfg.slippageBps} onChange={(e) => setCfg({ ...cfg, slippageBps: Number(e.target.value) })} disabled={running} /></div>
          </div>

          <div>
            <label>Whale addresses (comma-separated)</label>
            <input value={cfg.whaleAddresses} onChange={(e) => setCfg({ ...cfg, whaleAddresses: e.target.value })} placeholder="0x…, 0x…" disabled={running} />
          </div>

          <div className="row">
            <div>
              <label>ETH price USD (manual)</label>
              <input type="number" value={cfg.ethPriceUsd} onChange={(e) => setCfg({ ...cfg, ethPriceUsd: Number(e.target.value) })} disabled={running} />
            </div>
            <div>
              <label>Mode</label>
              <select value={paperMode ? "paper" : "live"} onChange={(e) => setPaperMode(e.target.value === "paper")} disabled={running}>
                <option value="paper">Paper (safe)</option>
                <option value="live">Live (real funds)</option>
              </select>
            </div>
          </div>

          <div className="row" style={{ justifyContent: "flex-start" }}>
            {!running ? (
              <button className="btn" onClick={startBot} style={{ flex: 0 }}>Start bot</button>
            ) : (
              <button className="btn danger" onClick={stopBot} style={{ flex: 0 }}>Stop bot</button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 10px" }}>Event log</h3>
        <div className="event-log" ref={logRef}>
          {events.length === 0 && <div style={{ color: "var(--text-dim)" }}>No events yet.</div>}
          {events.map((e, i) => <EventLine key={i} e={e} />)}
        </div>
      </div>
    </>
  );
}

function EventLine({ e }: { e: BotEvent }): JSX.Element {
  const ts = new Date().toLocaleTimeString();
  switch (e.kind) {
    case "discovered":
      return <div className="event discovered">[{ts}] discovered {e.token.baseToken.symbol} • ${e.token.priceUsd.toFixed(6)} • liq ${(e.token.liquidityUsd / 1000).toFixed(1)}k • 24h ${(e.token.volume24hUsd / 1000).toFixed(1)}k</div>;
    case "whale":
      return <div className="event">[{ts}] whale {e.event.whale.slice(0, 6)}… {e.event.type} {e.event.amount} {e.event.symbol ?? "?"} ({e.event.txHash.slice(0, 10)}…)</div>;
    case "buy":
      return <div className="event buy">[{ts}] BUY {e.token.slice(0, 8)}… for {e.amountEth} ETH {e.paper ? "(paper)" : ""} → {e.hash.slice(0, 10)}…</div>;
    case "sell":
      return <div className="event sell">[{ts}] SELL {e.token.slice(0, 8)}… reason={e.reason} {e.paper ? "(paper)" : ""} → {e.hash.slice(0, 10)}…</div>;
    case "skip":
      return <div className="event">[{ts}] skip {e.token.slice(0, 8)}… ({e.reason})</div>;
    case "error":
      return <div className="event error">[{ts}] ERROR {e.message}</div>;
  }
}
