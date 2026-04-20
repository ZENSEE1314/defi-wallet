import { useEffect, useState } from "react";
import { PasswordPrompt } from "../components/PasswordPrompt";
import type { WalletRecord } from "@shared/wallet/keystore";

type Mode = "list" | "create" | "import-mnemonic" | "import-pk";

export function WalletsPage(): JSX.Element {
  const [wallets, setWallets] = useState<WalletRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Mode>("list");
  const [revealing, setRevealing] = useState<WalletRecord | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WalletRecord | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendForm, setSendForm] = useState({ to: "", value: "", password: "" });

  async function refresh(): Promise<void> {
    const res = await window.walletApi.wallet.list();
    setWallets(res.wallets);
    setSelectedId(res.selectedId);
    for (const w of res.wallets) {
      window.walletApi.wallet.balance(w.id).then((b) => setBalances((prev) => ({ ...prev, [w.id]: b.eth }))).catch(() => {});
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSelect(id: string): Promise<void> {
    await window.walletApi.wallet.select(id);
    setSelectedId(id);
  }

  async function handleDelete(): Promise<void> {
    if (!confirmDelete) return;
    await window.walletApi.wallet.delete(confirmDelete.id);
    setConfirmDelete(null);
    await refresh();
  }

  async function handleSend(): Promise<void> {
    if (!selectedId) return;
    const res = await window.walletApi.wallet.send(selectedId, sendForm.password, sendForm.to, sendForm.value);
    alert(`Tx sent: ${res.hash}`);
    setSendOpen(false);
    setSendForm({ to: "", value: "", password: "" });
    await refresh();
  }

  return (
    <>
      <h2>Wallets</h2>

      <div className="card">
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button className="btn" onClick={() => setMode("create")} style={{ flex: 0 }}>+ New wallet</button>
          <button className="btn secondary" onClick={() => setMode("import-mnemonic")} style={{ flex: 0 }}>Import seed phrase</button>
          <button className="btn secondary" onClick={() => setMode("import-pk")} style={{ flex: 0 }}>Import private key</button>
        </div>
      </div>

      {wallets.length === 0 && (
        <div className="card" style={{ textAlign: "center", color: "var(--text-dim)" }}>
          No wallets yet. Create or import one to get started.
        </div>
      )}

      {wallets.map((w) => (
        <div key={w.id} className={`wallet-row ${w.id === selectedId ? "active" : ""}`} onClick={() => handleSelect(w.id)}>
          <div>
            <div style={{ fontWeight: 600 }}>{w.name} <span className="badge">{w.source}</span></div>
            <div className="address">{w.address}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="balance">{balances[w.id] ?? "…"} ETH</div>
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              <button className="btn ghost" onClick={(e) => { e.stopPropagation(); setRevealing(w); }}>Reveal</button>
              <button className="btn ghost" onClick={(e) => { e.stopPropagation(); setSendOpen(true); }}>Send</button>
              <button className="btn ghost" style={{ color: "var(--danger)" }} onClick={(e) => { e.stopPropagation(); setConfirmDelete(w); }}>Delete</button>
            </div>
          </div>
        </div>
      ))}

      {mode !== "list" && <CreateOrImportModal mode={mode} onClose={() => setMode("list")} onDone={() => { setMode("list"); refresh(); }} />}

      {revealing && (
        <PasswordPrompt
          title={`Reveal secret — ${revealing.name}`}
          message="Enter your password. The secret will be visible until you close this dialog."
          onCancel={() => { setRevealing(null); setRevealed(null); }}
          onSubmit={async (pwd) => {
            try {
              const res = await window.walletApi.wallet.reveal(revealing.id, pwd);
              setRevealed(res.secret);
            } catch (e) {
              alert(`Wrong password: ${(e as Error).message}`);
            }
          }}
        />
      )}

      {revealed && (
        <div className="modal-bg">
          <div className="modal">
            <h3>Secret (do not share)</h3>
            <textarea readOnly value={revealed} rows={4} style={{ fontFamily: "var(--mono)" }} />
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn" onClick={() => { setRevealed(null); setRevealing(null); }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-bg">
          <div className="modal">
            <h3>Delete wallet?</h3>
            <p>Removing <strong>{confirmDelete.name}</strong> deletes its encrypted keystore. If you don't have the seed phrase or private key backed up, the funds will be lost.</p>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn danger" onClick={handleDelete}>Delete permanently</button>
            </div>
          </div>
        </div>
      )}

      {sendOpen && (
        <div className="modal-bg">
          <div className="modal">
            <h3>Send native token</h3>
            <div className="col">
              <div><label>To address</label><input value={sendForm.to} onChange={(e) => setSendForm({ ...sendForm, to: e.target.value })} placeholder="0x…" /></div>
              <div><label>Amount</label><input value={sendForm.value} onChange={(e) => setSendForm({ ...sendForm, value: e.target.value })} placeholder="0.01" /></div>
              <div><label>Password</label><input type="password" value={sendForm.password} onChange={(e) => setSendForm({ ...sendForm, password: e.target.value })} /></div>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn secondary" onClick={() => setSendOpen(false)}>Cancel</button>
              <button className="btn" onClick={handleSend}>Send</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CreateOrImportModal({ mode, onClose, onDone }: { mode: Mode; onClose: () => void; onDone: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  async function go(): Promise<void> {
    if (!name || !password) return;
    if (password.length < 8) { alert("Password must be at least 8 characters."); return; }
    setBusy(true);
    try {
      if (mode === "create") await window.walletApi.wallet.create(name, password);
      else if (mode === "import-mnemonic") await window.walletApi.wallet.importMnemonic(name, secret, password);
      else if (mode === "import-pk") await window.walletApi.wallet.importPrivateKey(name, secret, password);
      onDone();
    } catch (e) {
      alert(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "create" ? "New wallet" : mode === "import-mnemonic" ? "Import seed phrase" : "Import private key";

  return (
    <div className="modal-bg">
      <div className="modal">
        <h3>{title}</h3>
        <div className="col">
          <div><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trading wallet" /></div>
          {mode !== "create" && (
            <div>
              <label>{mode === "import-mnemonic" ? "Seed phrase (12 or 24 words)" : "Private key (0x…)"}</label>
              <textarea value={secret} onChange={(e) => setSecret(e.target.value)} rows={mode === "import-mnemonic" ? 3 : 2} />
            </div>
          )}
          <div><label>Password (8+ chars)</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={go} disabled={busy}>{busy ? "Working…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
