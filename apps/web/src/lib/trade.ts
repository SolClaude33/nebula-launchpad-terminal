"use client";

// Órdenes reales del ticket y del Instant Trade (REQ-LIVE-002/003) contra la API local.
// El id de la orden lo genera la interfaz: un reintento o un doble clic con el mismo id no duplica nada.
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { fmtSol, fmtTokens } from "@/lib/format";
import { lamToSol, refreshLive, toTokens, useLive } from "@/lib/live";

export type Side = "buy" | "sell";
export type OrderItem = { ord: number; walletId: string; label: string; address: string; status: "PENDING" | "OK" | "FAILED" | "SKIPPED"; amount: string | null; result: string | null; signature: string | null; reason: string | null };
export type OrderView = { id: string; mint: string; side: Side; status: "RUNNING" | "PAUSED" | "COMPLETED" | "PARTIAL" | "FAILED"; items: OrderItem[] };
export type TradeQuote = {
  venue: "curve" | "migrating" | "pumpswap";
  padFeeBps: number;
  items: { walletId: string; label: string; ok: boolean; reason?: string; amountIn: string; expectedOut: string; limit: string }[];
  costs: { volume: string; network: string; priority: string; rent: string; padFee: string; jito: string; total: string };
  maxBuyPerWallet: string;
  rentPerAccount: string;
  feePerTx: string;
  tipPerTx: string;
};
export type OrderRequest = { side: Side; walletIds: string[]; lamportsEach?: string; pct?: number; slippagePct: number; mode?: "parallel" | "staggered" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Envía la orden, espera el resultado por wallet y lo muestra (entró / falló / omitida / pendiente). */
export async function runOrder(req: OrderRequest, source: "ticket" | "instant") {
  const mint = useLive.getState().mint;
  const decimals = useLive.getState().info?.decimals ?? 6;
  if (!mint) return null;
  const id = crypto.randomUUID();
  let v: OrderView;
  try {
    v = await api<OrderView>("/trade", { method: "POST", body: { id, mint, mode: "parallel", ...req, source } });
    for (let i = 0; i < 600 && v.status === "RUNNING"; i++) {
      await sleep(400);
      v = await api<OrderView>(`/trade/${id}`);
    }
  } catch (e) {
    toast({ tone: "error", title: req.side === "buy" ? "No se pudo comprar" : "No se pudo vender", body: (e as ApiError).message });
    return null;
  }
  const buy = req.side === "buy";
  const ok = v.items.filter((i) => i.status === "OK");
  const failed = v.items.filter((i) => i.status === "FAILED").length;
  const skipped = v.items.filter((i) => i.status === "SKIPPED").length;
  const pending = v.items.filter((i) => i.status === "PENDING").length;
  const got = ok.reduce((a, i) => a + Number(i.result ?? 0), 0);
  const where = source === "instant" ? "Instant Trade" : `Ticket · ${req.mode === "staggered" ? "escalonado" : "en paralelo"}`;
  toast({
    tone: pending ? "warn" : ok.length === 0 ? "error" : failed || skipped ? "warn" : buy ? "buy" : "sell",
    title: pending ? `${buy ? "Compra" : "Venta"} en pausa · confirmación pendiente` : `${buy ? "Compra" : "Venta"} · ${ok.length}/${v.items.length} wallets entraron`,
    body: `${where}${ok.length ? ` · ${buy ? `${fmtTokens(toTokens(got, decimals))} tokens` : fmtSol(lamToSol(got), 4)}` : ""}${failed ? ` · ${failed} fallaron` : ""}${skipped ? ` · ${skipped} omitidas` : ""}${pending ? " · reanúdala desde el aviso de pausa" : ""}`,
    lines: v.items.map((i) => ({
      label: i.label,
      status: i.status === "OK" ? "ok" : i.status === "FAILED" ? "failed" : i.status === "SKIPPED" ? "skipped" : "pending",
      detail: i.status === "OK" ? (i.result ? (buy ? `${fmtTokens(toTokens(i.result, decimals))} tokens` : fmtSol(lamToSol(i.result), 4)) : "confirmada") : (i.reason ?? (i.status === "PENDING" ? "Pendiente de confirmar" : undefined)),
    })),
  });
  void refreshLive();
  return v;
}

/** Vista previa del servidor (costes, MAX, motivo por wallet), con un pequeño retardo al teclear. */
export function useTradeQuote(req: { side: Side; walletIds: string[]; lamportsEach?: string; pct?: number; slippagePct: number } | null) {
  const mint = useLive((s) => s.mint);
  const [q, setQ] = useState<TradeQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = req && mint ? JSON.stringify({ mint, ...req }) : "";
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const t = setTimeout(() => {
      api<TradeQuote>("/trade/quote", { method: "POST", body: JSON.parse(key) })
        .then((r) => alive && (setQ(r), setError(null)))
        .catch((e) => alive && setError((e as ApiError).message));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);
  return { quote: key ? q : null, error: key ? error : null };
}

/** Selección de wallets por carpeta; la wallet dev queda fuera salvo que se incluya de forma explícita. */
export function useWalletPicker(storeKey: string) {
  const wallets = useLive((s) => s.wallets);
  const folders = useLive((s) => s.folders);
  const position = useLive((s) => s.position);
  const picked = useLive((s) => s.picked);
  const [scope, setScopeState] = useState<string>("all");
  const [includeDev, setIncludeDev] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem(storeKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- preferencia local leída tras montar
      if (v) setScopeState(v);
    } catch {}
  }, [storeKey]);
  const setScope = (v: string) => {
    setScopeState(v);
    try {
      localStorage.setItem(storeKey, v);
    } catch {}
  };
  const validScope = scope === "all" || scope === "picked" || folders.some((f) => f.id === scope) ? scope : "all";
  const pos = useMemo(() => new Map((position?.items ?? []).map((p) => [p.walletId, p])), [position]);
  const selected = useMemo(() => {
    // «Marcadas»: exactamente las marcadas en el panel (incluida la dev si se marcó a mano)
    if (validScope === "picked") return wallets.filter((w) => picked.includes(w.id)).map((w) => ({ ...w, tokens: BigInt(pos.get(w.id)?.tokens ?? "0"), lamports: BigInt(pos.get(w.id)?.lamports ?? "0") }));
    const base = validScope === "all" ? wallets : wallets.filter((w) => w.folderIds.includes(validScope));
    return base.filter((w) => includeDev || w.role !== "dev").map((w) => ({ ...w, tokens: BigInt(pos.get(w.id)?.tokens ?? "0"), lamports: BigInt(pos.get(w.id)?.lamports ?? "0") }));
  }, [wallets, validScope, includeDev, pos, picked]);
  const hasDev = validScope !== "picked" && (validScope === "all" ? wallets : wallets.filter((w) => w.folderIds.includes(validScope))).some((w) => w.role === "dev");
  return { folders: folders.filter((f) => wallets.some((w) => w.folderIds.includes(f.id))), scope: validScope, setScope, includeDev, setIncludeDev, hasDev, selected, pickedCount: picked.length };
}
