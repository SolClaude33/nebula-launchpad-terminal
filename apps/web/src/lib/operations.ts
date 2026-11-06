"use client";

import { api } from "@/lib/api";

export type OpItem = { idx: number; chunk: number; from: string; fromLabel: string; to: string; toLabel: string | null; lamports: string; status: "PENDING" | "OK" | "FAILED" | "SKIPPED"; signature?: string | null; reason?: string | null };
export type OperationView = {
  id: string;
  kind: "transfer" | "withdraw" | "disperse" | "collect";
  status: "PREVIEW" | "RUNNING" | "PAUSED" | "COMPLETED" | "PARTIAL" | "FAILED";
  items: OpItem[];
  chunks: { chunk: number; from: string; fee: string }[];
  errors: string[];
  warnings: string[];
  external: { address: string; newAddress: boolean; offCurve: boolean } | null;
  sources: { address: string; label: string; before: string; after: string }[];
  totalLamports: string;
  feeTotal: string;
  rentExemptMin: string;
};

export type OperationInput =
  | { kind: "transfer"; fromId: string; to: string; lamports?: string; max?: boolean }
  | { kind: "disperse"; fromId: string; toIds: string[]; lamportsEach: string }
  | { kind: "disperse"; fromId: string; amounts: { walletId: string; lamports: string }[] }
  | { kind: "collect"; fromIds: string[]; toId: string };

export const previewOp = (input: OperationInput) => api<OperationView>("/operations/preview", { method: "POST", body: input });
export const executeOp = (id: string, stepUp?: string) => api<OperationView>(`/operations/${id}/execute`, { method: "POST", body: {}, stepUp });
export const getOp = (id: string) => api<OperationView>(`/operations/${id}`);
export const resumeOp = (id: string) => api<OperationView>(`/operations/${id}/resume`, { method: "POST", body: {} });

/** "0,25" → lamports (string); null si no es un número válido > 0 */
export function solToLamportsStr(v: string): string | null {
  const s = v.trim().replace(",", ".");
  if (!/^\d+(\.\d{0,9})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  const l = BigInt(i) * 1_000_000_000n + BigInt((f + "000000000").slice(0, 9));
  return l > 0n ? l.toString() : null;
}
