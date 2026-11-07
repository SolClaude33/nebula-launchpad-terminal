"use client";

// Datos del Live Workspace (REQ-LIVE-001): la interfaz solo lee la API local, que indexa la cadena.
// Trades con cursor cada segundo; holders y posición cada pocos segundos. Nunca se toca el RPC desde aquí.
import { useEffect } from "react";
import { create } from "zustand";
import type { FolderDto, WalletDto } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { fmtSol, fmtUsd } from "@/lib/format";

export type Venue = "curve" | "migrating" | "pumpswap";
export type TokenInfo = {
  mint: string;
  venue: Venue;
  decimals: number;
  supply: string;
  creator: string;
  mayhem: boolean;
  priceLamports: number;
  marketCapLamports: string;
  graduationPct: number;
  graduationMcLamports: string;
  pool: string | null;
  padFeeBps: number;
  metadata: { name: string; symbol: string; uri: string } | null;
};
export type Trade = { seq: number; signature: string; venue: "curve" | "pumpswap"; side: "buy" | "sell"; lamports: string; tokens: string; user: string; ts: number; mc: string; own: { id: string; label: string } | null };
export type Holder = { owner: string; amount: string; system: string | null; own: { id: string; label: string; role: string | null } | null };
export type PosItem = { walletId: string; label: string; address: string; role: string | null; lamports: string; tokens: string; costLamports: number; valueLamports: number; realizedLamports: number };
type Snapshot = {
  info: TokenInfo;
  token: { name: string | null; symbol: string | null; own: boolean; feeMode: string | null; links: { x: string; telegram: string; web: string } | null; createdAt: number | null };
  trades: Trade[];
  cursor: number;
  stats: { trades: number; volumeLamports: string };
  solUsd: { usd: number; publishedAt: number } | null;
  live: { ws: boolean; error: string | null };
};

type LiveState = {
  mint: string | null;
  info: TokenInfo | null;
  token: Snapshot["token"] | null;
  stats: Snapshot["stats"] | null;
  solUsd: Snapshot["solUsd"];
  feed: Snapshot["live"] | null;
  trades: Trade[];
  cursor: number;
  holders: { complete: boolean; count: number; items: Holder[] } | null;
  position: { priceLamports: number; items: PosItem[]; total: { tokens: string; costLamports: number; valueLamports: number; realizedLamports: number; lamports: string } } | null;
  wallets: WalletDto[];
  folders: FolderDto[];
  /** Wallets marcadas en el panel «Mis wallets» (alcance «Marcadas» del ticket y del Instant Trade) */
  picked: string[];
  setPicked: (ids: string[]) => void;
  error: { status: number; message: string } | null;
  tick: () => Promise<void>;
  loadSide: () => Promise<void>;
  loadWallets: () => Promise<void>;
  reset: (mint: string) => void;
};

const MAX_TRADES = 4000;
const inflight = new Set<string>();

export const useLive = create<LiveState>((set, get) => ({
  mint: null,
  info: null,
  token: null,
  stats: null,
  solUsd: null,
  feed: null,
  trades: [],
  cursor: 0,
  holders: null,
  position: null,
  wallets: [],
  folders: [],
  picked: [],
  setPicked: (ids) => set({ picked: ids }),
  error: null,
  reset: (mint) => set({ mint, info: null, token: null, stats: null, feed: null, trades: [], cursor: 0, holders: null, position: null, picked: [], error: null }),
  tick: async () => {
    const { mint, cursor } = get();
    if (!mint) return;
    try {
      const s = await api<Snapshot>(`/live/${mint}?after=${cursor}`);
      if (get().mint !== mint) return;
      set((st) => ({
        info: s.info,
        token: s.token,
        stats: s.stats,
        solUsd: s.solUsd,
        feed: s.live,
        cursor: s.cursor,
        trades: cursor === 0 ? s.trades : s.trades.length ? [...st.trades, ...s.trades].slice(-MAX_TRADES) : st.trades,
        error: null,
      }));
    } catch (e) {
      const err = e as ApiError;
      set({ error: { status: err.status, message: err.message } });
    }
  },
  // Holders y posición por separado (uno lento no retrasa al otro) y sin solapar peticiones
  loadSide: async () => {
    const { mint } = get();
    if (!mint) return;
    const one = async <K extends "holders" | "position">(key: K, path: string) => {
      if (inflight.has(key)) return;
      inflight.add(key);
      try {
        const v = await api<LiveState[K]>(path);
        if (get().mint === mint) set({ [key]: v } as Pick<LiveState, K>);
      } catch {
      } finally {
        inflight.delete(key);
      }
    };
    await Promise.all([one("holders", `/live/${mint}/holders`), one("position", `/live/${mint}/position`)]);
  },
  loadWallets: async () => {
    try {
      const [w, f] = await Promise.all([api<{ wallets: WalletDto[] }>("/wallets"), api<{ folders: FolderDto[] }>("/folders")]);
      set({ wallets: w.wallets.filter((x) => x.kind === "wallet" && !x.archived), folders: f.folders });
    } catch {}
  },
}));

/** Arranca el sondeo del mint mientras el workspace está montado. */
export function useLiveFeed(mint: string) {
  useEffect(() => {
    const st = useLive.getState();
    st.reset(mint);
    void st.loadWallets();
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await useLive.getState().tick();
      if (alive) t = setTimeout(loop, 1000);
    };
    void loop();
    void useLive.getState().loadSide();
    const side = setInterval(() => void useLive.getState().loadSide(), 4000);
    return () => {
      alive = false;
      clearTimeout(t);
      clearInterval(side);
    };
  }, [mint]);
}

/** Tras una orden propia: refresca ya todo (sin esperar al siguiente ciclo). */
export async function refreshLive() {
  const st = useLive.getState();
  await Promise.all([st.tick(), st.loadSide(), st.loadWallets()]);
}

// ── Conversión y formato ───────────────────────────────
export const lamToSol = (v: string | number | bigint) => Number(v) / 1e9;
export const toTokens = (v: string | number, decimals = 6) => Number(v) / 10 ** decimals;

/** Formatea un importe en lamports en USD si hay precio de SOL; si no, en SOL. */
export function useMoney() {
  const solUsd = useLive((s) => s.solUsd?.usd ?? null);
  return { solUsd, usd: (lamports: number | string) => (solUsd ? lamToSol(lamports) * solUsd : null) };
}

/** Importe en lamports como USD (si hay precio de SOL) o como SOL. */
export const fmtMoney = (lamports: number | string, solUsd: number | null, compact = true) => (solUsd ? fmtUsd(lamToSol(lamports) * solUsd, compact) : fmtSol(lamToSol(lamports), compact ? 1 : 3));
