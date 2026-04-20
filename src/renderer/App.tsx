import { useEffect, useState } from "react";
import { WalletsPage } from "./pages/WalletsPage";
import { NetworksPage } from "./pages/NetworksPage";
import { BrowserPage } from "./pages/BrowserPage";
import { BotPage } from "./pages/BotPage";
import { PasswordPrompt } from "./components/PasswordPrompt";

type Tab = "wallets" | "networks" | "browser" | "bot";

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("wallets");
  const [pwdRequest, setPwdRequest] = useState<{ method: string; address: string } | null>(null);

  useEffect(() => {
    return window.walletApi.dapp.onPasswordRequest((info) => setPwdRequest(info));
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>DeFi Wallet</h1>
        <button className={`nav-item ${tab === "wallets" ? "active" : ""}`} onClick={() => setTab("wallets")}>Wallets</button>
        <button className={`nav-item ${tab === "networks" ? "active" : ""}`} onClick={() => setTab("networks")}>Networks</button>
        <button className={`nav-item ${tab === "browser" ? "active" : ""}`} onClick={() => { setTab("browser"); }}>dApp Browser</button>
        <button className={`nav-item ${tab === "bot" ? "active" : ""}`} onClick={() => setTab("bot")}>Trading Bot</button>
      </aside>

      <main className="main" style={{ padding: tab === "browser" ? 0 : 24 }}>
        {tab === "wallets" && <WalletsPage />}
        {tab === "networks" && <NetworksPage />}
        {tab === "browser" && <BrowserPage />}
        {tab === "bot" && <BotPage />}
      </main>

      {pwdRequest && (
        <PasswordPrompt
          title={`Confirm ${pwdRequest.method}`}
          message={`Enter password for ${pwdRequest.address.slice(0, 8)}…${pwdRequest.address.slice(-6)}`}
          onSubmit={(pwd) => {
            window.walletApi.dapp.sendPassword(pwd);
            setPwdRequest(null);
          }}
          onCancel={() => {
            window.walletApi.dapp.sendPassword(null);
            setPwdRequest(null);
          }}
        />
      )}
    </div>
  );
}
