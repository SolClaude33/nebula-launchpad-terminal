"use client";

import { create } from "zustand";
import { api, ApiError } from "@/lib/api";
import { toConfig, type Draft } from "@/lib/draft";

export type Check = { label: string; kind: "simulated" | "checked" | "setup"; ok: boolean; reason?: string; units?: number; action?: "create-alt" };
export type LaunchView = {
  id: string;
  status: "PREPARED" | "CREATING" | "CREATED" | "BUYING" | "DONE" | "FAILED" | "PAUSED";
  pausedFrom: string | null;
  mint: string;
  createSignature: string | null;
  error: string | null;
  name: string;
  symbol: string;
  mode: "quick" | "manual";
  preflight: { ok: boolean; checks: Check[]; at: number } | null;
  buys: { ord: number; walletId: string; label: string; lamports: number; status: "PENDING" | "OK" | "FAILED" | "SKIPPED"; tokens: string | null; signature: string | null; reason: string | null }[];
};

/** Huella de lo que se simuló: si cambia el borrador, el dry-run deja de valer. */
export const fingerprint = (d: Draft) => JSON.stringify({ ...toConfig(d), draftId: undefined });

type RunStore = {
  view: LaunchView | null;
  fp: string | null;
  busy: "dry" | "alt" | "launch" | null;
  error: string | null;
  load: (id: string) => Promise<void>;
  runDry: (d: Draft) => Promise<void>;
  createAlt: (payerWalletId: string, d: Draft) => Promise<void>;
  launch: (d: Draft) => Promise<void>;
  reset: () => void;
};

let poll: ReturnType<typeof setInterval> | undefined;
const active = (s?: string) => s === "CREATING" || s === "CREATED" || s === "BUYING";

export const useLaunchRun = create<RunStore>((set, get) => {
  const watch = (id: string) => {
    clearInterval(poll);
    poll = setInterval(async () => {
      try {
        const v = await api<LaunchView>(`/launches/${id}`);
        set({ view: v });
        if (!active(v.status)) clearInterval(poll);
      } catch {}
    }, 1000);
  };
  return {
    view: null,
    fp: null,
    busy: null,
    error: null,
    load: async (id) => {
      try {
        const v = await api<LaunchView>(`/launches/${id}`);
        set({ view: v, fp: null });
        if (active(v.status)) watch(id);
      } catch {
        set({ view: null });
      }
    },
    runDry: async (d) => {
      set({ busy: "dry", error: null });
      try {
        const v = await api<LaunchView>("/launches/preflight", { method: "POST", body: toConfig(d) });
        set({ view: v, fp: fingerprint(d) });
      } catch (e) {
        set({ error: (e as ApiError).message });
      }
      set({ busy: null });
    },
    createAlt: async (payerWalletId, d) => {
      set({ busy: "alt", error: null });
      try {
        await api("/launches/alt", { method: "POST", body: { payerWalletId } });
        set({ busy: null });
        await get().runDry(d);
        return;
      } catch (e) {
        set({ error: (e as ApiError).message });
      }
      set({ busy: null });
    },
    // REQ-LAUNCH-016: el servidor ignora el segundo clic (un lanzamiento por draftId)
    launch: async (d) => {
      if (get().busy === "launch") return;
      set({ busy: "launch", error: null });
      try {
        const v = await api<LaunchView>(`/launches/${d.draftId}/execute`, { method: "POST", body: {} });
        set({ view: v });
        if (active(v.status)) watch(v.id);
      } catch (e) {
        set({ error: (e as ApiError).message });
      }
      set({ busy: null });
    },
    reset: () => {
      clearInterval(poll);
      set({ view: null, fp: null, busy: null, error: null });
    },
  };
});
