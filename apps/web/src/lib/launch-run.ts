"use client";

import { create } from "zustand";
import { planAmounts, type Draft, type DryRow } from "@/lib/draft";

type DryState = { status: "idle" | "running" | "ok" | "fail"; rows: DryRow[]; fingerprint?: string };
type LaunchState = { status: "idle" | "pending" | "confirmed" | "scheduled"; key?: string; sig?: string };

/** Huella de lo que se simuló: si cambia el borrador, el dry-run deja de valer. */
export const fingerprint = (d: Draft) =>
  JSON.stringify([d.name, d.symbol, d.devBuy, d.launchMode, d.amountMode, d.fixedAmount, d.rangeMin, d.rangeMax, d.slippage, d.priorityFee, d.jitoTip, d.plan.map((p) => [p.id, p.balance]), d.devBalance, d.mode, d.feeMode]);

type RunStore = {
  dry: DryState;
  launch: LaunchState;
  runDry: (d: Draft) => Promise<void>;
  launchNow: (d: Draft) => Promise<void>;
  resetRun: () => void;
};

export const useLaunchRun = create<RunStore>((set, get) => ({
  dry: { status: "idle", rows: [] },
  launch: { status: "idle" },
  runDry: async (d) => {
    set({ dry: { status: "running", rows: [] } });
    const amounts = planAmounts(d);
    const rows: DryRow[] = [{ label: "Crear token + dev buy (bundle Jito)", kind: "create", ok: true, units: 182_400 }];
    d.plan.forEach((w, i) => {
      if (d.launchMode === "manual") return;
      const ok = w.balance >= amounts[i] + 0.0035;
      rows.push({ label: `Compra · ${w.label}`, kind: "buy", ok, units: 64_000 + ((i * 1733) % 9000), reason: ok ? undefined : "Saldo insuficiente: monto + fees + rent" });
    });
    for (let i = 0; i < rows.length; i++) {
      await new Promise((r) => setTimeout(r, 140));
      set({ dry: { status: "running", rows: rows.slice(0, i + 1) } });
    }
    set({ dry: { status: rows.every((r) => r.ok) ? "ok" : "fail", rows, fingerprint: fingerprint(d) } });
  },
  launchNow: async (d) => {
    // Idempotencia: el mismo borrador nunca produce dos tokens (REQ-LAUNCH-016)
    if (get().launch.status !== "idle") return;
    const key = `draft-${Math.abs([...fingerprint(d)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36)}`;
    if (d.schedule === "at") {
      set({ launch: { status: "scheduled", key } });
      return;
    }
    set({ launch: { status: "pending", key } });
    await new Promise((r) => setTimeout(r, 2200));
    set({ launch: { status: "confirmed", key, sig: "5kQx9Wd3eMoTnB2rVa8LpHc4YzN7uFsGj1Ki6RtEwXbP" } });
  },
  resetRun: () => set({ dry: { status: "idle", rows: [] }, launch: { status: "idle" } }),
}));
