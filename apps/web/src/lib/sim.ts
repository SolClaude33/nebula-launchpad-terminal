"use client";

// Motor de simulación del prototipo F0. Imita el flujo de datos del indexer
// (trades, velas, holders) y las ejecuciones del tx-sender, sin red ni firmas.
import { create } from "zustand";

export type Side = "buy" | "sell";
export type Role = "dev" | "holder" | "trading";

export type Trade = {
  id: string;
  t: number;
  side: Side;
  sol: number;
  tokens: number;
  mc: number;
  wallet: string;
  own: boolean;
  label?: string;
  sig: string;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number };

export type Wallet = {
  id: string;
  label: string;
  address: string;
  role: Role;
  folder: string;
  sol: number;
  tokens: number;
  costSol: number;
};

export type Folder = { id: string; name: string };

export type ExecStatus = "ok" | "failed" | "skipped";
export type ExecResult = { walletId: string; label: string; status: ExecStatus; reason?: string; sol?: number; sig?: string };

export type ExecRequest = {
  side: Side;
  walletIds: string[];
  /** compra: SOL por wallet */
  amountSol?: number;
  /** venta: porcentaje de la posición de cada wallet */
  pct?: number;
  slippage: number;
};

// Constantes de demostración (en F1 las da el adaptador de Pump.fun y el oráculo de precio).
export const SOL_USD = 162.4;
export const SUPPLY = 1_000_000_000;
export const GRAD_MC = 69_000;
export const BASE_FEE = 0.000005;
export const PRIORITY_FEE = 0.0001;
export const ATA_RENT = 0.00203928;
export const CANDLE_SEC = 5;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261106);
const gauss = () => {
  const u = 1 - rnd();
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const addr = (len = 44) => Array.from({ length: len }, () => B58[Math.floor(rnd() * B58.length)]).join("");
const sig = () => addr(87);
let seq = 0;
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const priceSol = (mc: number) => mc / SUPPLY / SOL_USD;

// ── Estado inicial ────────────────────────────────────────────────
function seedHistory(now: number) {
  const N = 1440; // 2 h de velas de 5 s
  const startLog = Math.log(4200);
  const endLog = Math.log(38_600);
  const logs: number[] = [startLog];
  for (let i = 1; i <= N; i++) logs.push(logs[i - 1] + 0.0015 + gauss() * 0.011);
  const drift = endLog - logs[N];
  const mcs = logs.map((l, i) => Math.exp(l + (drift * i) / N));
  const t0 = Math.floor(now / 1000 / CANDLE_SEC) * CANDLE_SEC - N * CANDLE_SEC;
  const candles: Candle[] = [];
  for (let i = 1; i <= N; i++) {
    const open = mcs[i - 1];
    const close = mcs[i];
    const wick = 1 + Math.abs(gauss()) * 0.0035;
    candles.push({ time: t0 + i * CANDLE_SEC, open, close, high: Math.max(open, close) * wick, low: Math.min(open, close) / wick });
  }
  return candles;
}

function seedWallets(): { wallets: Wallet[]; folders: Folder[] } {
  const folders: Folder[] = [
    { id: "f-holders", name: "Holders A" },
    { id: "f-trading", name: "Trading" },
    { id: "f-dev", name: "Dev" },
  ];
  const mc0 = 9_800; // market cap medio al que entraron las wallets propias
  const wallets: Wallet[] = [];
  const mk = (label: string, role: Role, folder: string, pct: number, sol: number): Wallet => {
    const tokens = Math.round(SUPPLY * pct);
    return { id: `w-${label.toLowerCase().replace(/\W+/g, "-")}`, label, address: addr(), role, folder, sol, tokens, costSol: tokens * priceSol(mc0 * (0.8 + rnd() * 0.5)) };
  };
  wallets.push(mk("Dev", "dev", "f-dev", 0.031, 0.84));
  for (let i = 1; i <= 8; i++) wallets.push(mk(`Holder ${String(i).padStart(2, "0")}`, "holder", "f-holders", 0.004 + rnd() * 0.005, 0.18 + rnd() * 0.35));
  for (let i = 1; i <= 3; i++) wallets.push(mk(`Trading ${i}`, "trading", "f-trading", rnd() < 0.5 ? 0 : 0.0015 + rnd() * 0.002, 1.1 + rnd() * 1.6));
  return { wallets, folders };
}

function seedHolders(wallets: Wallet[]) {
  const ext: Record<string, number> = {};
  for (let i = 0; i < 46; i++) ext[addr()] = Math.round(SUPPLY * Math.pow(rnd(), 2.6) * 0.022 + SUPPLY * 0.0004);
  const own = Object.fromEntries(wallets.filter((w) => w.tokens > 0).map((w) => [w.address, w.tokens]));
  return { ...ext, ...own } as Record<string, number>;
}

function seedTrades(candles: Candle[], now: number): Trade[] {
  const trades: Trade[] = [];
  for (let i = 0; i < 36; i++) {
    const c = candles[candles.length - 1 - i];
    const side: Side = c.close >= c.open ? "buy" : "sell";
    const sol = Math.min(4, Math.exp(gauss() * 0.9 - 1.3));
    trades.push({ id: uid(), t: now - i * (3000 + rnd() * 4000), side, sol, tokens: (sol * SOL_USD) / (c.close / SUPPLY), mc: c.close, wallet: addr(), own: false, sig: sig() });
  }
  return trades;
}

// ── Store ─────────────────────────────────────────────────────────
type SimState = {
  ready: boolean;
  mc: number;
  athMc: number;
  candles: Candle[];
  trades: Trade[];
  ownTrades: Trade[];
  holders: Record<string, number>;
  wallets: Wallet[];
  folders: Folder[];
  volumeSol: number;
  init: () => void;
  tick: () => void;
  execute: (req: ExecRequest) => Promise<ExecResult[]>;
};

function applyTrade(s: SimState, side: Side, sol: number, walletAddr: string, own: boolean, label?: string) {
  const sign = side === "buy" ? 1 : -1;
  const before = s.mc;
  const tokens = (sol * SOL_USD) / (before / SUPPLY);
  const mc = Math.min(GRAD_MC * 0.985, Math.max(3000, before + sign * sol * SOL_USD * 1.12));
  const now = Date.now();
  const trade: Trade = { id: uid(), t: now, side, sol, tokens, mc, wallet: walletAddr, own, label, sig: sig() };

  const bucket = Math.floor(now / 1000 / CANDLE_SEC) * CANDLE_SEC;
  const candles = s.candles.slice();
  const last = candles[candles.length - 1];
  if (last && last.time === bucket) {
    candles[candles.length - 1] = { ...last, close: mc, high: Math.max(last.high, mc), low: Math.min(last.low, mc) };
  } else {
    const open = last ? last.close : before;
    candles.push({ time: bucket, open, close: mc, high: Math.max(open, mc), low: Math.min(open, mc) });
    if (candles.length > 4000) candles.shift();
  }

  const holders = { ...s.holders };
  holders[walletAddr] = Math.max(0, (holders[walletAddr] ?? 0) + sign * tokens);
  if (holders[walletAddr] < 1) delete holders[walletAddr];

  return {
    mc,
    athMc: Math.max(s.athMc, mc),
    candles,
    holders,
    volumeSol: s.volumeSol + sol,
    trades: [trade, ...s.trades].slice(0, 200),
    ownTrades: own ? [trade, ...s.ownTrades] : s.ownTrades,
    trade,
  };
}

export const useSim = create<SimState>((set, get) => ({
  ready: false,
  mc: 0,
  athMc: 0,
  candles: [],
  trades: [],
  ownTrades: [],
  holders: {},
  wallets: [],
  folders: [],
  volumeSol: 0,

  init: () => {
    if (get().ready) return;
    const now = Date.now();
    const candles = seedHistory(now);
    const { wallets, folders } = seedWallets();
    const mc = candles[candles.length - 1].close;
    set({
      ready: true,
      mc,
      athMc: Math.max(...candles.map((c) => c.high)),
      candles,
      trades: seedTrades(candles, now),
      holders: seedHolders(wallets),
      wallets,
      folders,
      volumeSol: 412.6,
    });
  },

  tick: () => {
    const s = get();
    if (!s.ready) return;
    const pull = (s.mc - 41_000) / 41_000; // vuelve suavemente hacia ~41K
    const side: Side = rnd() < 0.53 - pull * 0.25 ? "buy" : "sell";
    const sol = Math.min(4, Math.max(0.01, Math.exp(gauss() * 0.95 - 1.4)));
    const holderAddrs = Object.keys(s.holders);
    const ownAddrs = new Set(s.wallets.map((w) => w.address));
    let wallet = addr();
    if (side === "sell" || rnd() < 0.4) {
      const ext = holderAddrs.filter((a) => !ownAddrs.has(a));
      wallet = ext[Math.floor(rnd() * ext.length)] ?? wallet;
    }
    const { trade: _t, ...patch } = applyTrade(s, side, sol, wallet, false);
    void _t;
    set(patch);
  },

  execute: async (req) => {
    const latency = 220 + rnd() * 380;
    await new Promise((r) => setTimeout(r, latency));
    const results: ExecResult[] = [];
    for (const id of req.walletIds) {
      const s = get();
      const w = s.wallets.find((x) => x.id === id);
      if (!w) continue;
      const fees = BASE_FEE + PRIORITY_FEE + (req.side === "buy" && w.tokens === 0 ? ATA_RENT : 0);
      if (req.side === "buy") {
        const amt = req.amountSol ?? 0;
        if (w.sol < amt + fees) {
          results.push({ walletId: id, label: w.label, status: "skipped", reason: "Saldo insuficiente para monto + fees" });
          continue;
        }
      } else if (w.tokens <= 0) {
        results.push({ walletId: id, label: w.label, status: "skipped", reason: "Sin tokens" });
        continue;
      }
      // Fallo de slippage simulado: más probable cuanto menor es la tolerancia.
      const failChance = req.slippage < 3 ? 0.35 : req.slippage < 8 ? 0.12 : 0.05;
      if (rnd() < failChance) {
        results.push({ walletId: id, label: w.label, status: "failed", reason: `Slippage excedido (${req.slippage.toLocaleString("es-ES")} %)` });
        set({ wallets: s.wallets.map((x) => (x.id === id ? { ...x, sol: x.sol - BASE_FEE - PRIORITY_FEE } : x)) });
        continue;
      }
      if (req.side === "buy") {
        const amt = req.amountSol ?? 0;
        const { trade, ...patch } = applyTrade(s, "buy", amt, w.address, true, w.label);
        set({
          ...patch,
          wallets: s.wallets.map((x) => (x.id === id ? { ...x, sol: x.sol - amt - fees, tokens: x.tokens + trade.tokens, costSol: x.costSol + amt } : x)),
        });
        results.push({ walletId: id, label: w.label, status: "ok", sol: amt, sig: trade.sig });
      } else {
        const pct = Math.min(100, req.pct ?? 100) / 100;
        const tokens = w.tokens * pct;
        const sol = tokens * priceSol(s.mc);
        const { trade, ...patch } = applyTrade(s, "sell", sol, w.address, true, w.label);
        set({
          ...patch,
          wallets: s.wallets.map((x) => (x.id === id ? { ...x, sol: x.sol + sol - fees, tokens: x.tokens - tokens, costSol: x.costSol * (1 - pct) } : x)),
        });
        results.push({ walletId: id, label: w.label, status: "ok", sol, sig: trade.sig });
      }
    }
    return results;
  },
}));

export function usePosition(walletIds?: string[]) {
  const wallets = useSim((s) => s.wallets);
  const mc = useSim((s) => s.mc);
  const list = walletIds ? wallets.filter((w) => walletIds.includes(w.id)) : wallets;
  const tokens = list.reduce((a, w) => a + w.tokens, 0);
  const cost = list.reduce((a, w) => a + w.costSol, 0);
  const value = tokens * priceSol(mc);
  const sol = list.reduce((a, w) => a + w.sol, 0);
  return { tokens, cost, value, pnl: value - cost, pnlPct: cost > 0 ? ((value - cost) / cost) * 100 : 0, sol, supplyPct: (tokens / SUPPLY) * 100 };
}
