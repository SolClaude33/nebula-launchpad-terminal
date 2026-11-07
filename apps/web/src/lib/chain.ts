"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api";

export type ChainStatus = { profile: "test" | "mainnet"; mode: "rpc" | "mock" | "off"; healthy: boolean; host: string | null; latencyMs: number | null; usingBackup: boolean; error: string | null; sendPerSec?: number; jito?: JitoStatus };
/** F2 · bloque 5: propina de Jito por compra, venta y creación ("0" si está apagado); `simulated` en el perfil de pruebas. */
export type JitoStatus = { enabled: boolean; tipLamports: string; simulated: boolean };

/** Propina de Jito por transacción (0n si está apagado). */
export const useJitoTip = () => {
  const t = useChain((s) => s.status?.jito?.tipLamports ?? "0");
  return BigInt(t);
};

type ChainStore = {
  status: ChainStatus | null;
  balances: Record<string, bigint>;
  balancesAt: number;
  balancesError: string | null;
  refreshStatus: () => Promise<void>;
  refreshBalances: () => Promise<void>;
};

export const useChain = create<ChainStore>((set) => ({
  status: null,
  balances: {},
  balancesAt: 0,
  balancesError: null,
  refreshStatus: async () => {
    try {
      set({ status: await api<ChainStatus>("/chain/status") });
    } catch {
      set({ status: null });
    }
  },
  refreshBalances: async () => {
    try {
      const r = await api<{ at: number; balances: Record<string, string> }>("/wallets/balances");
      set({ balances: Object.fromEntries(Object.entries(r.balances).map(([a, v]) => [a, BigInt(v)])), balancesAt: r.at, balancesError: null });
    } catch (e) {
      set({ balancesError: (e as Error).message });
    }
  },
}));

/** Sondea el estado del RPC cada 5 s (topbar). */
export function useChainStatusPolling() {
  const refreshStatus = useChain((s) => s.refreshStatus);
  useEffect(() => {
    refreshStatus();
    const a = setInterval(refreshStatus, 5000);
    return () => clearInterval(a);
  }, [refreshStatus]);
}

/** Sondea los saldos cada 10 s mientras la bóveda está abierta. */
export function useBalancesPolling() {
  const refreshBalances = useChain((s) => s.refreshBalances);
  useEffect(() => {
    refreshBalances();
    const b = setInterval(refreshBalances, 10_000);
    return () => clearInterval(b);
  }, [refreshBalances]);
}

export const fmtLamports = (l: bigint | undefined, digits = 4) => {
  if (l === undefined) return "—";
  const sol = Number(l) / 1e9;
  return `${sol.toLocaleString("es-ES", { minimumFractionDigits: sol === 0 ? 0 : 2, maximumFractionDigits: digits })} SOL`;
};
