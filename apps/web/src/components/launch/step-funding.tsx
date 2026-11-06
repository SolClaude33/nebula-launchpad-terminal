"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, GripVertical, Landmark, Loader2, Plus, X } from "lucide-react";
import { ALL_HOLDERS, DEV_WALLET, devNeed, estimates, FUNDER_BALANCE, num, planAmounts, useDraft, walletNeeds } from "@/lib/draft";
import { BASE_FEE } from "@/lib/sim";
import { fmtSol, shortAddr } from "@/lib/format";
import { SectionTitle } from "./ui";

const COLS = "grid-cols-[24px_minmax(0,1fr)_78px_78px_96px] xl:grid-cols-[28px_minmax(0,1fr)_120px_120px_130px]";

export function StepFunding() {
  const d = useDraft((s) => s.draft);
  const set = useDraft((s) => s.set);
  const [dragId, setDragId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);

  const est = estimates(d);
  const rows = walletNeeds(d);
  const amounts = planAmounts(d);
  const devShort = Math.max(0, devNeed(d) - d.devBalance);
  const toSend = rows.reduce((a, r) => a + r.short, 0) + devShort;
  const transfers = rows.filter((r) => r.short > 0).length + (devShort > 0 ? 1 : 0);
  const fees = transfers * BASE_FEE;
  const available = d.plan.length < ALL_HOLDERS.length ? ALL_HOLDERS.filter((h) => !d.plan.some((p) => p.id === h.id)) : [];

  const move = (from: number, to: number) => {
    if (to < 0 || to >= d.plan.length) return;
    const plan = d.plan.slice();
    const [it] = plan.splice(from, 1);
    plan.splice(to, 0, it);
    set({ plan });
  };

  function distribute() {
    setSending(true);
    setTimeout(() => {
      set((cur) => ({
        devBalance: Math.max(cur.devBalance, devNeed(cur) + 0.001),
        plan: cur.plan.map((w) => {
          const r = walletNeeds(cur).find((x) => x.id === w.id)!;
          return { ...w, balance: Math.max(w.balance, r.need + 0.001) };
        }),
      }));
      setSending(false);
      setConfirming(false);
    }, 1100);
  }

  return (
    <div className="rise">
      <SectionTitle index="Paso 3 de 4 · Financiación" title="Fondos del plan" body="Cada wallet necesita su compra más fees y rent. Lo que falte se dispersa desde el funder." />

      <div className="mb-5 grid grid-cols-3 gap-3">
        <div className="panel p-4">
          <p className="telemetry flex items-center gap-1.5">
            <Landmark className="size-3" aria-hidden /> Funder predeterminado
          </p>
          <p className="num mt-1.5 text-[20px]">{fmtSol(FUNDER_BALANCE)}</p>
          <p className="num text-[11.5px] text-faint">8Qd1…wF3k</p>
        </div>
        <div className="panel p-4">
          <p className="telemetry">Falta dispersar</p>
          <p className={`num mt-1.5 text-[20px] ${toSend > 0 ? "text-warn" : "text-buy"}`}>{fmtSol(toSend)}</p>
          <p className="text-[11.5px] text-faint">{transfers} transferencias · fees {fmtSol(fees, 6)}</p>
        </div>
        <div className="panel p-4">
          <p className="telemetry">Supply en wallets propias</p>
          <p className="num mt-1.5 text-[20px]">{(est.devPct + est.holdersPct).toLocaleString("es-ES", { maximumFractionDigits: 2 })} %</p>
          <p className="text-[11.5px] text-faint">
            dev {est.devPct.toLocaleString("es-ES", { maximumFractionDigits: 2 })} % · holders {est.holdersPct.toLocaleString("es-ES", { maximumFractionDigits: 2 })} %
          </p>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="text-[13px] font-medium">
            Orden de compra <span className="ml-1 text-[12px] font-normal text-faint">arrastra para reordenar · también con las flechas</span>
          </p>
          {available.length > 0 && d.launchMode === "quick" && (
            <button onClick={() => set({ plan: [...d.plan, available[0]] })} className="btn h-8">
              <Plus className="size-3.5" aria-hidden /> Añadir wallet
            </button>
          )}
        </div>
        <div aria-hidden className={`grid ${COLS} gap-3 border-b border-line bg-surface-2/40 px-4 py-2`}>
          <span />
          <span className="telemetry">Wallet</span>
          <span className="telemetry text-right">Compra</span>
          <span className="telemetry text-right">Saldo</span>
          <span className="telemetry text-right">Estado</span>
        </div>
        <ol>
          <li className={`grid ${COLS} items-center gap-3 border-b border-line/70 bg-surface-2/30 px-4 py-2.5 text-[12.5px]`}>
            <span className="num text-faint">0</span>
            <span>
              <span className="font-medium">Dev</span> <span className="chip ml-1 h-5 border-warn/30 px-1.5 text-[10.5px] text-warn">creación + dev buy</span>
              <span className="num block text-[11px] text-faint">{shortAddr(DEV_WALLET.address)}</span>
            </span>
            <span className="num text-right">{fmtSol(num(d.devBuy) || 0)}</span>
            <span className="num text-right text-muted">{fmtSol(d.devBalance)}</span>
            <Status short={devShort} />
          </li>
          {d.launchMode === "manual" ? (
            <li className="px-4 py-6 text-center text-[13px] text-muted">Modo Manual: solo se financia la wallet dev.</li>
          ) : (
            rows.map((w, i) => (
              <li
                key={w.id}
                draggable
                onDragStart={() => setDragId(w.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const from = d.plan.findIndex((p) => p.id === dragId);
                  if (from >= 0) move(from, i);
                  setDragId(null);
                }}
                onDragEnd={() => setDragId(null)}
                className={`group grid ${COLS} items-center gap-3 border-b border-line/50 px-4 py-2.5 text-[12.5px] transition-colors last:border-0 ${dragId === w.id ? "opacity-40" : "hover:bg-surface-2/50"}`}
              >
                <span className="flex items-center gap-0.5 text-faint">
                  <GripVertical className="size-3.5 cursor-grab" aria-hidden />
                  <span className="num">{i + 1}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span>
                    <span className="font-medium">{w.label}</span>
                    <span className="num block text-[11px] text-faint">{shortAddr(w.address)}</span>
                  </span>
                  <span className="ml-auto flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <button onClick={() => move(i, i - 1)} aria-label={`Subir ${w.label}`} className="btn-ghost grid size-6 place-items-center rounded">
                      <ArrowUp className="size-3" />
                    </button>
                    <button onClick={() => move(i, i + 1)} aria-label={`Bajar ${w.label}`} className="btn-ghost grid size-6 place-items-center rounded">
                      <ArrowDown className="size-3" />
                    </button>
                    <button onClick={() => set({ plan: d.plan.filter((p) => p.id !== w.id) })} aria-label={`Quitar ${w.label}`} className="btn-ghost grid size-6 place-items-center rounded">
                      <X className="size-3" />
                    </button>
                  </span>
                </span>
                <span className="num text-right">{fmtSol(amounts[i])}</span>
                <span className="num text-right text-muted">{fmtSol(w.balance)}</span>
                <Status short={w.short} />
              </li>
            ))
          )}
        </ol>
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <p className="text-[12.5px] text-muted">{toSend > 0 ? "Se valida el saldo de cada wallet antes de habilitar «Lanzar»." : "Todas las wallets del plan tienen saldo suficiente."}</p>
        <button onClick={() => setConfirming(true)} disabled={toSend <= 0} className="cta h-10 px-4 text-[13px] font-medium">
          Distribuir {fmtSol(toSend)} desde el funder
        </button>
      </div>

      {confirming && (
        <div role="dialog" aria-modal="true" aria-labelledby="dist-title" className="fixed inset-0 z-[90] grid place-items-center bg-black/55 backdrop-blur-sm" onKeyDown={(e) => e.key === "Escape" && !sending && setConfirming(false)}>
          <div className="glass rise w-[420px] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-float)]">
            <h3 id="dist-title" className="text-[16px] font-semibold">
              Confirmar dispersión
            </h3>
            <p className="mt-1 text-[13px] text-muted">Desde el funder 8Qd1…wF3k a {transfers} wallets propias.</p>
            <dl className="mt-4 space-y-1.5 rounded-[var(--radius-sm)] border border-line bg-surface-2/50 p-3 text-[12.5px]">
              <div className="flex justify-between">
                <dt className="text-muted">Total a enviar</dt>
                <dd className="num">{fmtSol(toSend)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Fees de red ({transfers} tx)</dt>
                <dd className="num">{fmtSol(fees, 6)}</dd>
              </div>
              <div className="flex justify-between border-t border-line pt-1.5">
                <dt>Saldo del funder después</dt>
                <dd className="num">{fmtSol(FUNDER_BALANCE - toSend - fees)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-[12px] text-faint">La dispersión sigue en curso aunque cierres este diálogo.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button autoFocus onClick={() => setConfirming(false)} disabled={sending} className="btn h-9">
                Cancelar
              </button>
              <button onClick={distribute} disabled={sending} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
                {sending && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
                {sending ? "Enviando…" : "Confirmar y enviar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Status({ short }: { short: number }) {
  return short > 0 ? (
    <span className="num text-right text-[12px] text-warn">faltan {fmtSol(short)}</span>
  ) : (
    <span className="flex items-center justify-end gap-1 text-[12px] text-buy">
      <CheckCircle2 className="size-3.5" aria-hidden /> listo
    </span>
  );
}
