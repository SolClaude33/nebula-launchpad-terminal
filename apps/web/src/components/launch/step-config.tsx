"use client";

import Link from "next/link";
import { CalendarClock, ShieldAlert, TriangleAlert } from "lucide-react";
import { buysAfterCreate, fieldErrors, useDraft } from "@/lib/draft";
import { fmtLamports } from "@/lib/chain";
import { Field, RadioCard, SectionTitle, Suffix } from "./ui";
import { useLaunchData } from "./use-launch-data";
import { VanityMint } from "./vanity-mint";

const PADS = [
  { id: "pumpfun", name: "Pump.fun", chain: "Solana", ready: true },
  { id: "launchlab", name: "Raydium LaunchLab", chain: "Solana", ready: false },
  { id: "bonk", name: "LetsBonk", chain: "Solana", ready: false },
  { id: "fourmeme", name: "Four.meme", chain: "BNB Chain", ready: false },
];

export function StepConfig() {
  const d = useDraft((s) => s.draft);
  const set = useDraft((s) => s.set);
  const fe = fieldErrors(d);
  const { wallets, balances, loaded } = useLaunchData();
  const candidates = wallets.filter((w) => w.kind === "wallet" && !w.archived).sort((a, b) => Number(b.role === "dev") - Number(a.role === "dev"));

  return (
    <div className="rise space-y-8">
      <SectionTitle index="Paso 2 de 4 · Configuración" title="Cómo se lanza" body="Opciones del pad, wallet dev, dev buy y modo de lanzamiento." />

      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">Launchpad</legend>
        <div className="grid grid-cols-4 gap-2">
          {PADS.map((p) => (
            <div key={p.id} aria-disabled={!p.ready} className={`rounded-[var(--radius-md)] border p-3 ${p.ready ? "border-accent/50 bg-[color-mix(in_oklab,var(--accent-a)_8%,var(--surface-1))]" : "border-line bg-surface-1 opacity-55"}`}>
              <p className="text-[13px] font-medium">{p.name}</p>
              <p className="mt-0.5 text-[11.5px] text-muted">{p.chain}</p>
              <p className={`telemetry mt-2 text-[9.5px] ${p.ready ? "text-accent-b" : ""}`}>{p.ready ? "Seleccionado" : "Próximamente"}</p>
            </div>
          ))}
        </div>
      </fieldset>

      <VanityMint draftId={d.draftId} />

      <Field id="devWallet" label="Wallet dev" hint="Crea el token y hace el dev buy. Las comisiones de creador van a esta wallet." error={!d.devWalletId && loaded && candidates.length === 0 ? "No hay wallets: crea una con rol dev en Wallets." : undefined}>
        <div className="flex gap-2">
          <select id="devWallet" value={d.devWalletId} onChange={(e) => set({ devWalletId: e.target.value, plan: d.plan.filter((p) => p !== e.target.value) })} className={`field h-10 py-0${d.review?.includes("devWallet") ? " ring-2 ring-warn/60 ring-offset-2 ring-offset-[var(--bg)]" : ""}`}>
            <option value="">Elige una wallet…</option>
            {candidates.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
                {w.role ? ` · ${w.role}` : ""} · {fmtLamports(balances[w.address], 3)}
              </option>
            ))}
          </select>
          <Link href="/wallets" className="btn h-10 shrink-0">
            Gestionar wallets
          </Link>
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-6">
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium">Modo del pad</legend>
          <div className="space-y-2">
            <RadioCard name="mode" value="classic" checked={d.mode === "classic"} onSelect={() => set({ mode: "classic" })} title="Classic" body="Bonding curve estándar de Pump.fun, cotizada en SOL." />
            <RadioCard name="mode" value="mayhem" checked={d.mode === "mayhem"} onSelect={() => set({ mode: "mayhem" })} title="Mayhem" body="Variante del pad. Exige cotización en SOL o USDC." />
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 flex items-center gap-2 text-[13px] font-medium">
            Destino de las comisiones <span className="chip h-5 border-warn/30 px-1.5 text-[10.5px] text-warn">irreversible</span>
          </legend>
          <div className="space-y-2">
            <RadioCard name="fee" value="creator" checked={d.feeMode === "creator"} onSelect={() => set({ feeMode: "creator", feeAck: false })} title="Creator Fees" body="Las comisiones de creador van a la wallet dev." />
            <RadioCard name="fee" value="holders" checked={d.feeMode === "holders"} onSelect={() => set({ feeMode: "holders", feeAck: false })} title="Holder Rewards" body="Las comisiones se reparten entre holders. No podrás reclamarlas tú." />
          </div>
          <label id="feeAck" className={`mt-3 flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] border p-3 text-[12.5px] ${d.feeAck ? "border-line bg-surface-1" : "border-warn/35 bg-[var(--warn-soft)]"}${d.review?.includes("feeAck") ? " ring-2 ring-warn/60 ring-offset-2 ring-offset-[var(--bg)]" : ""}`}>
            <input type="checkbox" checked={d.feeAck} onChange={(e) => set({ feeAck: e.target.checked })} className="mt-0.5 size-4 accent-[var(--warn)]" />
            <span>
              <TriangleAlert className="mr-1 inline size-3.5 -translate-y-px text-warn" aria-hidden />
              Entiendo que <strong>{d.feeMode === "creator" ? "Creator Fees" : "Holder Rewards"}</strong> no se puede cambiar después de lanzar.
            </span>
          </label>
        </fieldset>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field id="devBuy" label="Dev buy" error={fe.devBuy} hint="Va en la misma transacción que la creación: todo o nada.">
          <div className="relative">
            <input id="devBuy" inputMode="decimal" value={d.devBuy} onChange={(e) => set({ devBuy: e.target.value })} aria-invalid={!!fe.devBuy} aria-describedby="devBuy-msg" className="field num h-10 pr-12" />
            <Suffix>SOL</Suffix>
          </div>
        </Field>
        <Field id="slippage" label="Slippage de compra" error={fe.slippage} hint="Se envía exactamente este valor. Nunca 100 % en silencio. La priority fee sale de Ajustes.">
          <div className="relative">
            <input id="slippage" inputMode="decimal" value={d.slippage} onChange={(e) => set({ slippage: e.target.value })} aria-invalid={!!fe.slippage} aria-describedby="slippage-msg" className="field num h-10 pr-8" />
            <Suffix>%</Suffix>
          </div>
        </Field>
      </div>

      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">Modo de lanzamiento</legend>
        <div className="grid grid-cols-3 gap-2">
          <RadioCard name="lm" value="quick" checked={d.launchMode === "quick"} onSelect={() => set({ launchMode: "quick" })} title="Quick" body="Tras crear el token compran, en orden, las wallets holder del plan (paso 3). Verás la supply que queda en wallets propias." />
          <RadioCard name="lm" value="pro" checked={d.launchMode === "pro"} onSelect={() => set({ launchMode: "pro" })} title="Pro" body="Como Quick, pero eliges cuántos milisegundos espera cada wallet antes de comprar (paso 3). Esperas fijas, sin aleatoriedad." />
          <RadioCard name="lm" value="manual" checked={d.launchMode === "manual"} onSelect={() => set({ launchMode: "manual" })} title="Manual" body="Solo crea el token con el dev buy." />
        </div>
        {buysAfterCreate(d) && (
          <div className="mt-3 grid grid-cols-[auto_1fr] items-start gap-4 rounded-[var(--radius-md)] border border-line bg-surface-1 p-4">
            <div role="radiogroup" aria-label="Monto por wallet" className="flex rounded-[var(--radius-sm)] border border-line bg-surface-2 p-0.5">
              {(["fixed", "range", "custom"] as const).map((m) => (
                <button key={m} role="radio" aria-checked={d.amountMode === m} onClick={() => set({ amountMode: m })} className={`h-8 rounded-[6px] px-3 text-[12.5px] ${d.amountMode === m ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
                  {m === "fixed" ? "Monto fijo" : m === "range" ? "Rango" : "Por wallet"}
                </button>
              ))}
            </div>
            {d.amountMode !== "range" ? (
              <Field id="fixedAmount" label={d.amountMode === "custom" ? "SOL por defecto" : "SOL por wallet"} error={fe.fixedAmount} hint={d.amountMode === "custom" ? "Cada wallet nueva empieza con este monto; cámbialo por wallet en el paso 3." : undefined}>
                <div className="relative max-w-[200px]">
                  <input id="fixedAmount" inputMode="decimal" value={d.fixedAmount} onChange={(e) => set({ fixedAmount: e.target.value })} aria-invalid={!!fe.fixedAmount} className="field num h-9 pr-12" />
                  <Suffix>SOL</Suffix>
                </div>
              </Field>
            ) : (
              <Field id="rangeMin" label="SOL por wallet (mín. – máx.)" error={fe.range}>
                <div className="flex max-w-[320px] items-center gap-2">
                  <input id="rangeMin" aria-label="Mínimo" inputMode="decimal" value={d.rangeMin} onChange={(e) => set({ rangeMin: e.target.value })} aria-invalid={!!fe.range} className="field num h-9" />
                  <span className="text-faint">–</span>
                  <input aria-label="Máximo" inputMode="decimal" value={d.rangeMax} onChange={(e) => set({ rangeMax: e.target.value })} aria-invalid={!!fe.range} className="field num h-9" />
                </div>
              </Field>
            )}
          </div>
        )}
      </fieldset>

      {buysAfterCreate(d) && <GuardPanel />}

      <p className="flex items-start gap-2 rounded-[var(--radius-md)] border border-line bg-surface-1 p-3.5 text-[12.5px] text-muted">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-accent-b" aria-hidden />
        <span>
          <span className="block text-[13.5px] font-medium text-fg">Lanzamiento programado</span>
          Se elige en el paso 4, junto al botón Lanzar, con el dry-run en verde. Se guarda en este equipo y sobrevive a un reinicio.
        </span>
      </p>
    </div>
  );
}

/** REQ-LAUNCH-014 · Launch Guard: «Complete Early» sin Nuke. Solo omite compras propias; nunca vende. */
function GuardPanel() {
  const d = useDraft((s) => s.draft);
  const set = useDraft((s) => s.set);
  const fe = fieldErrors(d);
  return (
    <fieldset className="rounded-[var(--radius-md)] border border-line bg-surface-1 p-4">
      <legend className="sr-only">Launch Guard</legend>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={d.guardEnabled} onChange={(e) => set({ guardEnabled: e.target.checked })} className="mt-1 accent-[var(--accent-b)]" />
        <span>
          <span className="flex items-center gap-2 text-[13.5px] font-medium">
            <ShieldAlert className="size-4 text-accent-b" aria-hidden /> Launch Guard
          </span>
          <span className="mt-0.5 block text-[12.5px] text-muted">Si otros compran más de un umbral mientras compran tus holders, se detienen las compras planificadas que quedan («Complete Early»). No vende nada.</span>
        </span>
      </label>
      {d.guardEnabled && (
        <div className="mt-3 grid grid-cols-[160px_160px_minmax(0,1fr)] gap-3">
          <Field id="guardSol" label="Umbral de compras externas" error={fe.guardSol}>
            <div className="relative">
              <input id="guardSol" inputMode="decimal" value={d.guardSol} onChange={(e) => set({ guardSol: e.target.value })} aria-invalid={!!fe.guardSol} className="field num h-9 pr-12" />
              <Suffix>SOL</Suffix>
            </div>
          </Field>
          <Field id="guardSec" label="Ventana tras crear" error={fe.guardSec}>
            <div className="relative">
              <input id="guardSec" inputMode="numeric" value={d.guardSec} onChange={(e) => set({ guardSec: e.target.value })} aria-invalid={!!fe.guardSec} className="field num h-9 pr-8" />
              <Suffix>s</Suffix>
            </div>
          </Field>
          <Field id="guardWhitelist" label="Lista blanca (no cuentan como externas)" error={fe.guardWhitelist}>
            <textarea id="guardWhitelist" rows={2} placeholder="Direcciones separadas por comas o líneas" value={d.guardWhitelist} onChange={(e) => set({ guardWhitelist: e.target.value })} aria-invalid={!!fe.guardWhitelist} className="field num min-h-9 resize-y text-[12px]" />
          </Field>
        </div>
      )}
    </fieldset>
  );
}
