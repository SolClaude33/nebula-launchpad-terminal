"use client";

import { create } from "zustand";
import type { VaultStatus } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";

type VaultStore = {
  status: VaultStatus | null;
  error: ApiError | null;
  /** momento (ms) en que se leyó lockInSec, para la cuenta atrás local */
  readAt: number;
  refresh: () => Promise<VaultStatus | null>;
  set: (s: VaultStatus) => void;
  lock: () => Promise<void>;
  heartbeat: () => void;
};

let lastBeat = 0;

export const useVault = create<VaultStore>((set, get) => ({
  status: null,
  error: null,
  readAt: 0,
  refresh: async () => {
    try {
      const s = await api<VaultStatus>("/vault/status");
      set({ status: s, error: null, readAt: Date.now() });
      return s;
    } catch (e) {
      set({ error: e as ApiError });
      return null;
    }
  },
  set: (s) => set({ status: s, error: null, readAt: Date.now() }),
  lock: async () => {
    const s = await api<VaultStatus>("/vault/lock", { method: "POST" });
    get().set(s);
  },
  // La actividad del operador retrasa el bloqueo automático (como mucho un aviso cada 20 s).
  heartbeat: () => {
    const now = Date.now();
    if (now - lastBeat < 20_000 || !get().status?.unlocked) return;
    lastBeat = now;
    api<{ lockInSec: number }>("/vault/activity", { method: "POST" })
      .then((r) => set((st) => ({ status: st.status ? { ...st.status, lockInSec: r.lockInSec } : st.status, readAt: Date.now() })))
      .catch(() => {});
  },
}));

export const forceHeartbeat = () => {
  lastBeat = 0;
  useVault.getState().heartbeat();
};
