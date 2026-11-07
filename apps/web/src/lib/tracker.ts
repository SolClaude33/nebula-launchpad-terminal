"use client";

// REQ-LIVE-006: tracker de tokens contra la API local. La lista ligera (sin cadena) la usan la estrella del Live
// y la paleta de comandos; la página del tracker pide la lista completa con market cap y graduación.
import { create } from "zustand";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

export type TrackedLite = { mint: string; addedAt: number; name: string | null; symbol: string | null; own: boolean };
export type Tracked = TrackedLite & { venue: string | null; marketCapLamports: string | null; mcUsd: number | null; graduationPct: number | null; updatedAt: number | null; error: string | null };

type TrackerStore = { items: TrackedLite[] | null; refresh: () => Promise<void> };
export const useTracked = create<TrackerStore>((set) => ({
  items: null,
  refresh: async () => {
    try {
      set({ items: (await api<{ items: TrackedLite[] }>("/tracker?lite=1")).items });
    } catch {}
  },
}));

export async function trackToken(mint: string) {
  try {
    const r = await api<{ added: boolean }>("/tracker", { method: "POST", body: { mint } });
    toast({ tone: "info", title: r.added ? "Añadido al tracker" : "Ya estaba en el tracker" });
    await useTracked.getState().refresh();
    return true;
  } catch (e) {
    toast({ tone: "error", title: "No se pudo añadir", body: (e as ApiError).message });
    return false;
  }
}

export async function untrackToken(mint: string) {
  try {
    await api(`/tracker/${mint}`, { method: "DELETE" });
    await useTracked.getState().refresh();
  } catch (e) {
    toast({ tone: "error", title: "No se pudo quitar", body: (e as ApiError).message });
  }
}
