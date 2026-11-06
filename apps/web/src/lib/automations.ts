"use client";

// REQ-AUTO-001…010: automatizaciones contra la API local. El motor vive en el servidor; aquí solo se
// listan, se crean y se gobiernan (iniciar, pausar, reanudar, editar en pausa, parar, de nuevo, duplicar, borrar).
import { useCallback, useEffect, useState } from "react";
import type { AutoStatus, AutomationConfig } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

export type AutoView = {
  id: string;
  type: "dca" | "limit";
  side: "buy" | "sell";
  label: string;
  mint: string;
  symbol: string | null;
  status: AutoStatus;
  generation: number;
  config: AutomationConfig;
  wallets: { id: string; label: string; dev: boolean }[];
  includesDev: boolean;
  progress: { executions: number; planned: number | null; spent: string; total: string | null; nextAmount: string } | { fired: number; targets: number; next: number | null };
  state: { startAt: number | null; endsAt: number | null; nextAt: number | null; waiting: string | null; lastError: string | null; endReason: string | null; consecErrors: number; mcUsd: number | null; inFlight: string | null };
  createdAt: number;
  updatedAt: number;
};

export type ExecItem = { walletId: string; label: string | null; side: "buy" | "sell"; status: "PENDING" | "OK" | "FAILED" | "SKIPPED"; amount: string | null; result: string | null; signature: string | null; reason: string | null; retries: number };
export type Execution = { cursor: number; seq: number; generation: number; orderId: string; at: number; mcUsd: number | null; target: number | null; orderStatus: string; items: ExecItem[] };

export const STATUS_LABEL: Record<AutoStatus, string> = { IDLE: "sin iniciar", RUNNING: "en marcha", PAUSED: "en pausa", COMPLETED: "completada", STOPPED: "parada", FAILED: "fallida", TIMEOUT: "caducada" };
export const STATUS_TONE: Record<AutoStatus, string> = {
  IDLE: "text-muted",
  RUNNING: "text-accent-b border-[color-mix(in_oklab,var(--accent-b)_40%,transparent)]",
  PAUSED: "text-warn border-[color-mix(in_oklab,var(--warn)_40%,transparent)]",
  COMPLETED: "text-buy border-[color-mix(in_oklab,var(--buy)_40%,transparent)]",
  STOPPED: "text-muted",
  FAILED: "text-sell border-[color-mix(in_oklab,var(--sell)_40%,transparent)]",
  TIMEOUT: "text-faint",
};
export const ACTIVE: AutoStatus[] = ["IDLE", "RUNNING", "PAUSED"];

/** Lista (opcionalmente de un mint) que se refresca cada 2 s mientras el componente está montado. */
export function useAutomations(mint?: string | null) {
  const [items, setItems] = useState<AutoView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ items: AutoView[] }>(`/automations${mint ? `?mint=${encodeURIComponent(mint)}` : ""}`);
      setItems(r.items);
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, [mint]);
  useEffect(() => {
    let alive = true;
    const run = () => alive && void load();
    run();
    const id = setInterval(run, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [load]);
  return { items, error, reload: load };
}

export type Action = "start" | "pause" | "resume" | "stop" | "rerun" | "duplicate" | "delete";
const DONE: Record<Action, string> = { start: "Iniciada", pause: "En pausa", resume: "Reanudada", stop: "Parada", rerun: "Ejecutándose de nuevo", duplicate: "Duplicada", delete: "Borrada" };

export async function act(id: string, action: Action) {
  try {
    const r = action === "delete" ? await api(`/automations/${id}`, { method: "DELETE" }) : await api<AutoView>(`/automations/${id}/${action}`, { method: "POST", body: {} });
    toast({ tone: action === "stop" || action === "delete" ? "info" : "buy", title: DONE[action] });
    return r;
  } catch (e) {
    toast({ tone: "error", title: "No se pudo", body: (e as ApiError).message });
    return null;
  }
}

export async function saveAutomation(input: { id?: string; label?: string; config: AutomationConfig; start?: boolean }) {
  if (input.id) return api<AutoView>(`/automations/${input.id}`, { method: "PATCH", body: { config: input.config, label: input.label } });
  return api<AutoView>("/automations", { method: "POST", body: { id: crypto.randomUUID(), label: input.label, config: input.config, start: input.start ?? false } });
}

export async function loadExecutions(id: string, before?: number) {
  return api<{ items: Execution[]; before: number | null }>(`/automations/${id}/executions?limit=20${before ? `&before=${before}` : ""}`);
}

const pad = (n: number) => String(n).padStart(2, "0");
export function fmtDuration(sec: number) {
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h} h ${pad(m)} min` : `${h} h`;
}
/** Hora actual que se refresca cada segundo (cuentas atrás de la próxima ejecución). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function fmtIn(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  return s < 1 ? "ahora" : `en ${fmtDuration(s)}`;
}
