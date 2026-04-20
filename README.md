# DeFi Wallet

A multi-chain EVM wallet with an embedded dApp browser and an auto-trading bot. Built with Electron + React + ethers.js v6.

## Features

- **Wallet management** — create new HD wallets, import seed phrase or private key, delete, switch between wallets. Keystores are AES-256-GCM encrypted with a PBKDF2-SHA256 key (310k iterations).
- **Multi-chain** — built-in support for Ethereum, Base, Arbitrum, Optimism, Polygon, Sepolia. Add custom EVM chains by Chain ID + RPC URL.
- **Embedded dApp browser** — Electron `BrowserView` with an EIP-1193 provider injected via preload. Connects to Uniswap, Aave, 1inch, etc. as `window.ethereum`.
- **Trading bot**
  - **Discovery** — polls Dexscreener for new tokens matching liquidity / volume / age filters.
  - **Whale tracking** — subscribes to ERC20 `Transfer` logs for any address you watch; auto-follows their buys.
  - **Auto-execute** — buys via Uniswap V3 SwapRouter02 (single-hop, configurable fee tier and slippage); sells on take-profit or stop-loss.
  - **Paper mode** — runs the full pipeline without sending transactions. Use this first.

## Run locally

```bash
npm install
npm run dev      # starts Vite + Electron with hot reload
```

Build for distribution:

```bash
npm run build
npm start
```

## Run the bot headlessly

The bot also runs standalone (without the desktop UI) for VPS deployment:

```bash
cp .env.example .env       # fill in BOT_PRIVATE_KEY, BOT_RPC_URL, etc.
npm run bot
```

## Deploy the bot to Railway

The Electron wallet itself is desktop-only. The headless bot can run as a Railway worker.

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo → pick `defi-wallet`.
3. Railway auto-detects the `railway.json` start command (`npm run bot`).
4. Set these env vars in the Railway service:
   - `BOT_RPC_URL` — private RPC (Flashbots Protect, Alchemy, etc.)
   - `BOT_CHAIN_ID` — `1` (mainnet), `8453` (Base), etc.
   - `BOT_PRIVATE_KEY` — hex private key for a **dedicated burner wallet**
   - `DISCOVERY_MIN_LIQUIDITY_USD`, `DISCOVERY_MIN_VOLUME_24H_USD`, `DISCOVERY_MAX_AGE_HOURS`
   - `WHALE_ADDRESSES` — comma-separated 0x addresses
   - `AUTO_BUY_USD`, `AUTO_SELL_PROFIT_PCT`, `AUTO_STOP_LOSS_PCT`, `SLIPPAGE_BPS`
   - `PAPER_MODE` — `true` (default) or `false` to send live transactions
5. Watch logs in Railway. Each event is one JSON line.

## Security model

- Private keys are **never** stored unencrypted on disk. The keystore (`%APPDATA%/defi-wallet/wallet-state.json` on Windows) holds only the AES-GCM ciphertext + PBKDF2 salt.
- Decryption happens in the Electron main process and the plaintext is held in memory only for the duration of a single transaction signature, then discarded.
- The dApp browser preload uses `contextIsolation: true` and `nodeIntegration: false`. The injected `window.ethereum` only proxies whitelisted RPC methods through IPC.
- **Every signing request requires the wallet password.** There is no auto-unlock.
- The trading bot, in contrast, holds the private key in memory for as long as it is running. **Use a dedicated burner wallet for the bot.**

## Auto-trading risks (read this)

- Token discovery from Dexscreener catches a lot of rugpulls. Honeypot detection is **not** implemented; the bot will happily buy a token you can't sell.
- Slippage tolerance is applied as a coarse `amountIn`-based floor, not a quoted minimum. For thin liquidity this can hurt.
- The bot has no MEV protection. Use a private RPC (Flashbots Protect, MEV Blocker) for `BOT_RPC_URL`.
- Start in paper mode. Always.

## Architecture

```
src/
├── main/             Electron main process (IPC handlers, store, dApp browser host)
├── preload/          Context-isolated bridges (wallet API + EIP-1193 provider)
├── renderer/         React UI (Vite dev server)
└── shared/
    ├── wallet/       HD keygen, AES-GCM crypto, keystore
    ├── chains/       Chain registry
    ├── storage/      AppState schema
    ├── bot/          Discovery, whale tracker, swap, bot orchestrator
    └── ipc.ts        IPC channel constants + DTOs
```

## What's intentionally not in v1

- Hardware wallet support (Ledger, Trezor)
- WalletConnect v2 (the embedded browser covers most use cases)
- ERC-20 / NFT balance display in the UI (only native balance)
- Honeypot / rugpull detection
- Real price feed for `ethPriceUsd` — currently entered manually in the bot config

## Contributing

This is a personal project. Issues and PRs are welcome but unmaintained.
