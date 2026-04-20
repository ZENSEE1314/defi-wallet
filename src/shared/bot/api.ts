// HTTP control plane for the bot.
//
// Exposes:
//   GET  /api/status   — running state, paper mode, positions, mode toggles
//   GET  /api/logs     — last N events (ring buffer, in-memory)
//   GET  /api/trades   — trade history (in-memory ring buffer)
//   POST /api/toggle   — flip { paperMode | momentum | frontrun } at runtime
//   POST /api/clear    — clear logs / trades buffers
//
// Auth: every request must carry `Authorization: Bearer <BOT_API_TOKEN>`.
// CORS: open by default — anyone with the token can call.
//
// In-memory only. If the Railway container restarts, history resets. That's
// fine for "live ops" view; persistent storage would need SQLite + a volume.

import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import type { TradingBot, BotEvent } from "./bot";

const LOG_RING_SIZE = 500;
const TRADE_RING_SIZE = 200;

export type RuntimeFlags = {
  paperMode: boolean;
  momentumEnabled: boolean;
  frontrunEnabled: boolean;
};

export type Trade = {
  ts: number;
  kind: "buy" | "sell";
  source: "momentum" | "whale-follow" | "frontrun" | "discovery" | "exit";
  symbol?: string;
  token: string;
  amountEth?: string;
  reason?: string;
  pnlPct?: number;
  hash: string;
  paper: boolean;
};

export class BotApi {
  private app = express();
  private logs: BotEvent[] = [];
  private trades: Trade[] = [];
  private bot: TradingBot;
  private token: string;
  private flags: RuntimeFlags;

  constructor(bot: TradingBot, token: string, flags: RuntimeFlags) {
    this.bot = bot;
    this.token = token;
    this.flags = flags;
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(this.auth.bind(this));
    this.routes();

    bot.on("event", (e: BotEvent) => this.recordEvent(e));
  }

  listen(port: number): void {
    this.app.listen(port, () => {
      console.log(JSON.stringify({ kind: "api-listening", port }));
    });
  }

  getFlags(): RuntimeFlags {
    return { ...this.flags };
  }

  private auth(req: Request, res: Response, next: NextFunction): void {
    // Allow CORS preflight + a tiny health endpoint without auth
    if (req.method === "OPTIONS" || req.path === "/api/health") return next();
    const hdr = req.header("authorization") ?? "";
    const m = hdr.match(/^Bearer\s+(.+)$/);
    if (!m || m[1] !== this.token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  }

  private routes(): void {
    this.app.get("/api/health", (_req, res) => res.json({ ok: true }));

    this.app.get("/api/status", (_req, res) => {
      const status = this.bot.status();
      res.json({
        running: status.running,
        positions: status.positions,
        flags: this.flags,
        logCount: this.logs.length,
        tradeCount: this.trades.length
      });
    });

    this.app.get("/api/logs", (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? "200"), LOG_RING_SIZE);
      res.json({ events: this.logs.slice(-limit).reverse() });
    });

    this.app.get("/api/trades", (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? "100"), TRADE_RING_SIZE);
      res.json({ trades: this.trades.slice(-limit).reverse() });
    });

    this.app.post("/api/toggle", (req, res) => {
      const body = req.body as Partial<RuntimeFlags>;
      if (typeof body.paperMode === "boolean") this.flags.paperMode = body.paperMode;
      if (typeof body.momentumEnabled === "boolean") this.flags.momentumEnabled = body.momentumEnabled;
      if (typeof body.frontrunEnabled === "boolean") this.flags.frontrunEnabled = body.frontrunEnabled;
      // Notify the running bot — it watches `getFlags()` per tick for paperMode,
      // but mode toggles (momentum/frontrun) require a process restart to take
      // effect because the underlying scanners are spun up at start().
      res.json({ flags: this.flags, note: "paperMode applies immediately. Enabling/disabling momentum or frontrun requires a Railway redeploy to take effect." });
    });

    this.app.post("/api/clear", (req, res) => {
      const target = (req.query.target as string) ?? "all";
      if (target === "logs" || target === "all") this.logs = [];
      if (target === "trades" || target === "all") this.trades = [];
      res.json({ ok: true });
    });
  }

  private recordEvent(e: BotEvent): void {
    this.logs.push(e);
    if (this.logs.length > LOG_RING_SIZE) this.logs.shift();

    // Project a Trade record from buy/sell events
    const trade = projectTrade(e);
    if (trade) {
      this.trades.push(trade);
      if (this.trades.length > TRADE_RING_SIZE) this.trades.shift();
    }
  }
}

function projectTrade(e: BotEvent): Trade | null {
  // Top-level discovery/whale-follow buys & sells
  if (e.kind === "buy") {
    return {
      ts: Date.now(),
      kind: "buy",
      source: e.hash.includes("WHALE") ? "whale-follow" : "discovery",
      token: e.token,
      amountEth: e.amountEth,
      hash: e.hash,
      paper: e.paper
    };
  }
  if (e.kind === "sell") {
    return {
      ts: Date.now(),
      kind: "sell",
      source: "exit",
      token: e.token,
      reason: e.reason,
      hash: e.hash,
      paper: e.paper
    };
  }
  // Momentum scanner trades
  if (e.kind === "momentum") {
    const me = e.event;
    if (me.kind === "buy") {
      return {
        ts: Date.now(),
        kind: "buy",
        source: "momentum",
        symbol: me.symbol,
        token: me.token,
        amountEth: me.amountEth,
        hash: me.hash,
        paper: me.paper
      };
    }
    if (me.kind === "sell") {
      return {
        ts: Date.now(),
        kind: "sell",
        source: "momentum",
        symbol: me.symbol,
        token: me.token,
        reason: me.reason,
        pnlPct: me.pnlPct,
        hash: me.hash,
        paper: me.paper
      };
    }
  }
  // Front-runner fires
  if (e.kind === "frontrun" && e.event.kind === "fired") {
    return {
      ts: Date.now(),
      kind: "buy",
      source: "frontrun",
      token: "(unknown — see logs)",
      hash: e.event.ourHash,
      paper: e.event.paper
    };
  }
  return null;
}
