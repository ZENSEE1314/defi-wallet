import { useEffect, useState } from "react";
import type { Chain } from "@shared/chains/registry";

export function NetworksPage(): JSX.Element {
  const [chains, setChains] = useState<Chain[]>([]);
  const [selectedId, setSelectedId] = useState<number>(1);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Omit<Chain, "isCustom">>({ id: 0, name: "", symbol: "", rpcUrl: "", explorerUrl: "" });

  async function refresh(): Promise<void> {
    const res = await window.walletApi.chain.list();
    setChains(res.chains);
    setSelectedId(res.selectedId);
  }

  useEffect(() => { refresh(); }, []);

  async function handleSelect(id: number): Promise<void> {
    await window.walletApi.chain.select(id);
    setSelectedId(id);
  }

  async function handleAdd(): Promise<void> {
    if (!form.id || !form.name || !form.rpcUrl) { alert("id, name, rpcUrl required"); return; }
    try {
      await window.walletApi.chain.add(form);
      setAdding(false);
      setForm({ id: 0, name: "", symbol: "", rpcUrl: "", explorerUrl: "" });
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function handleRemove(id: number): Promise<void> {
    if (!confirm("Remove this network?")) return;
    await window.walletApi.chain.remove(id);
    await refresh();
  }

  return (
    <>
      <h2>Networks</h2>
      <div className="card">
        <button className="btn" onClick={() => setAdding(true)} style={{ width: "auto" }}>+ Add custom network</button>
      </div>

      {chains.map((c) => (
        <div key={c.id} className={`wallet-row ${c.id === selectedId ? "active" : ""}`} onClick={() => handleSelect(c.id)}>
          <div>
            <div style={{ fontWeight: 600 }}>
              {c.name} {c.isCustom && <span className="badge">custom</span>}
            </div>
            <div className="address">Chain ID {c.id} • {c.symbol} • {c.rpcUrl}</div>
          </div>
          <div>
            {c.isCustom && (
              <button className="btn ghost" style={{ color: "var(--danger)" }} onClick={(e) => { e.stopPropagation(); handleRemove(c.id); }}>
                Remove
              </button>
            )}
          </div>
        </div>
      ))}

      {adding && (
        <div className="modal-bg">
          <div className="modal">
            <h3>Add custom network</h3>
            <div className="col">
              <div><label>Chain ID</label><input type="number" value={form.id || ""} onChange={(e) => setForm({ ...form, id: Number(e.target.value) })} /></div>
              <div><label>Name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div><label>Symbol</label><input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="ETH" /></div>
              <div><label>RPC URL</label><input value={form.rpcUrl} onChange={(e) => setForm({ ...form, rpcUrl: e.target.value })} placeholder="https://…" /></div>
              <div><label>Explorer URL</label><input value={form.explorerUrl} onChange={(e) => setForm({ ...form, explorerUrl: e.target.value })} placeholder="https://…" /></div>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn" onClick={handleAdd}>Add</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
