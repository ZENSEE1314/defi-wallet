import { useEffect, useState } from "react";

const SHORTCUTS = [
  { name: "Uniswap", url: "https://app.uniswap.org" },
  { name: "Aave", url: "https://app.aave.com" },
  { name: "Curve", url: "https://curve.fi" },
  { name: "1inch", url: "https://app.1inch.io" },
  { name: "Lido", url: "https://stake.lido.fi" }
];

export function BrowserPage(): JSX.Element {
  const [url, setUrl] = useState("https://app.uniswap.org");

  useEffect(() => {
    // Show the BrowserView when this page mounts; hide when leaving.
    return () => {
      window.walletApi.dapp.hide();
    };
  }, []);

  async function go(target: string): Promise<void> {
    let u = target.trim();
    if (!u.startsWith("http")) u = `https://${u}`;
    setUrl(u);
    await window.walletApi.dapp.open(u);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div className="browser-bar">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(url)}
          placeholder="https://app.uniswap.org"
        />
        <button className="btn" style={{ flex: 0 }} onClick={() => go(url)}>Go</button>
      </div>
      <div className="browser-tabs">
        {SHORTCUTS.map((s) => (
          <button key={s.url} className="tab" onClick={() => go(s.url)}>{s.name}</button>
        ))}
      </div>
      {/* The Electron BrowserView renders below this point. */}
    </div>
  );
}
