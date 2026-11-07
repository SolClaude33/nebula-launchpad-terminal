"use client";

// REQ-LAUNCH-018 / REQ-AUTO-009: presets reutilizables contra la API local. El servidor descarta lo que nunca
// debe guardarse (identidad del token, confirmación de comisiones, mint de una tarea).
import { api } from "@/lib/api";
import type { Draft } from "@/lib/draft";

export type PresetKind = "launch" | "task";
export type Preset = { id: string; kind: PresetKind; name: string; data: Record<string, unknown>; createdAt: number; updatedAt: number };

const newId = () => `p-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Date.now().toString(36)}`;

export const listPresets = (kind: PresetKind) => api<{ items: Preset[] }>(`/presets?kind=${kind}`).then((r) => r.items);
export const savePreset = (kind: PresetKind, name: string, data: Record<string, unknown>, id?: string) => api<Preset>(`/presets/${id ?? newId()}`, { method: "PUT", body: { kind, name, data } });
export const deletePreset = (id: string) => api(`/presets/${id}`, { method: "DELETE" });

/** Campos del borrador que forman un preset de lanzamiento (configuración, no identidad del token). */
const LAUNCH_KEYS = ["mode", "feeMode", "devWalletId", "devBuy", "launchMode", "amountMode", "fixedAmount", "rangeMin", "rangeMax", "slippage", "plan", "delaysMs", "amounts", "guardEnabled", "guardSol", "guardSec", "guardWhitelist"] as const;

export const launchPresetFrom = (d: Draft) => Object.fromEntries(LAUNCH_KEYS.map((k) => [k, d[k]])) as Record<string, unknown>;

/** Qué hay que revisar tras cargar un preset (ids de campo del asistente). */
export type ReviewItem = "devWallet" | "feeAck" | "plan";
export const REVIEW_LABEL: Record<ReviewItem, { label: string; step: 2 | 3 }> = {
  devWallet: { label: "la wallet dev y su saldo", step: 2 },
  feeAck: { label: "la confirmación de comisiones (irreversible)", step: 2 },
  plan: { label: "el plan de compras y su financiación", step: 3 },
};

/**
 * Aplica un preset a un borrador. Las wallets que ya no existen (o están archivadas) se quitan del plan;
 * la confirmación de comisiones siempre vuelve a quedar sin marcar.
 */
export function applyLaunchPreset(d: Draft, data: Record<string, unknown>, activeWalletIds: Set<string>) {
  const patch: Partial<Draft> = {};
  for (const k of LAUNCH_KEYS) if (k in data) (patch as Record<string, unknown>)[k] = data[k];
  const plan = Array.isArray(patch.plan) ? (patch.plan as string[]).filter((id) => activeWalletIds.has(id)) : d.plan;
  const dropped = Array.isArray(patch.plan) ? (patch.plan as string[]).length - plan.length : 0;
  const dev = typeof patch.devWalletId === "string" && activeWalletIds.has(patch.devWalletId) ? patch.devWalletId : "";
  const keep = <T,>(m: unknown) => Object.fromEntries(Object.entries((m as Record<string, T>) ?? {}).filter(([id]) => plan.includes(id))) as Record<string, T>;
  const review: ReviewItem[] = ["devWallet", "feeAck", ...((patch.launchMode ?? d.launchMode) !== "manual" ? (["plan"] as const) : [])];
  return { patch: { ...patch, plan, devWalletId: dev, delaysMs: keep<string>(patch.delaysMs), amounts: keep<string>(patch.amounts), feeAck: false, review }, dropped, devMissing: !!data.devWalletId && !dev };
}
