"use client";

import { ATA_RENT, BASE_FEE, PRIORITY_FEE, useSim, type ExecRequest, type Wallet } from "@/lib/sim";
import { toast } from "@/lib/toast";
import { fmtSol } from "@/lib/format";

export const PAD_FEE_PCT = 1; // demo; en F1 lo informa el adaptador de Pump.fun

/** Desglose de costes de una orden multi-wallet (REQ-COST-001). */
export function estimate(side: "buy" | "sell", wallets: Wallet[], amountSol: number) {
  const n = wallets.length;
  const newAtas = side === "buy" ? wallets.filter((w) => w.tokens === 0).length : 0;
  const volume = side === "buy" ? amountSol * n : amountSol;
  const network = BASE_FEE * n;
  const priority = PRIORITY_FEE * n;
  const rent = ATA_RENT * newAtas;
  const pad = (volume * PAD_FEE_PCT) / 100;
  return { n, volume, network, priority, rent, pad, total: side === "buy" ? volume + network + priority + rent : network + priority };
}

/** MAX por wallet reservando fees y rent (REQ-COST-002). */
export function maxBuyPerWallet(wallets: Wallet[]) {
  if (wallets.length === 0) return 0;
  const reserve = (w: Wallet) => BASE_FEE + PRIORITY_FEE + (w.tokens === 0 ? ATA_RENT : 0) + 0.001;
  const min = Math.min(...wallets.map((w) => w.sol - reserve(w)));
  return Math.max(0, Math.floor(min * 1000) / 1000);
}

export async function runOrder(req: ExecRequest, source: string) {
  const results = await useSim.getState().execute(req);
  const ok = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const sol = ok.reduce((a, r) => a + (r.sol ?? 0), 0);
  const buy = req.side === "buy";
  toast({
    tone: ok.length === 0 ? "error" : failed || skipped ? "warn" : buy ? "buy" : "sell",
    title: `${buy ? "Compra" : "Venta"} · ${ok.length}/${results.length} wallets entraron`,
    body: `${source} · ${fmtSol(sol)}${failed ? ` · ${failed} fallaron` : ""}${skipped ? ` · ${skipped} omitidas` : ""}`,
    lines: results.map((r) => ({ label: r.label, status: r.status, detail: r.status === "ok" ? fmtSol(r.sol ?? 0) : r.reason })),
    href: ok[0]?.sig ? `https://solscan.io/tx/${ok[0].sig}` : undefined,
  });
  return results;
}
