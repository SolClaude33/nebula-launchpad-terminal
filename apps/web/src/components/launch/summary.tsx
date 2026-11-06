"use client";

import Link from "next/link";
import { useId } from "react";
import { AlertCircle, CalendarClock, Check, CheckCircle2, CircleDashed, CloudOff, Info, Loader2, Rocket } from "lucide-react";
import { CURVE, estimates, issues, useDraft } from "@/lib/draft";
import { fingerprint, useLaunchRun } from "@/lib/launch-run";
import { fmtSol, fmtUsd } from "@/lib/format";
import { DEMO_ROUTE } from "@/lib/demo";
import { TokenGlyph } from "@/components/live/token-header";

function Tip({ text }: { text: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <button type="button" aria-describedby={id} aria-label="Ver fórmula" className="grid size-4 place-items-center rounded text-faint hover:text-fg">
        <Info className="size-3" />
      </button>
      <span role="tooltip" id={id} className="pointer-events-none invisible absolute right-0 bottom-full z-50 mb-1.5 w-64 rounded-[var(--radius-sm)] border border-line-strong bg-surface-3 p-2.5 text-[11.5px] leading-relaxed text-fg opacity-0 shadow-[var(--shadow-float)] transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
        {text}
      </span>
    </span>
  );
}

function SaveChip() {
  const save = useDraft((s) => s.save);
  const map = {
    unsaved: { icon: <CircleDashed className="size-3" aria-hidden />, text: "Sin guardar", cls: "" },
    saving: { icon: <Loader2 className="size-3 animate-spin" aria-hidden />, text: "Guardando…", cls: "" },
    saved: { icon: <Check className="size-3" aria-hidden />, text: "Guardado", cls: "text-buy border-buy/25" },
    error: { icon: <CloudOff className="size-3" aria-hidden />, text: "Error al guardar", cls: "text-sell border-sell/30" },
  }[save];
  return (
    <span aria-live="polite" className={`chip h-6 ${map.cls}`}>
      {map.icon}
      {map.text}
    </span>
  );
}

export function LaunchSummary({ goto }: { goto: (step: number, field?: string) => void }) {
  const d = useDraft((s) => s.draft);
  const est = estimates(d);
  const list = issues(d);
  const dry = useLaunchRun((s) => s.dry);
  const launch = useLaunchRun((s) => s.launch);
  const launchNow = useLaunchRun((s) => s.launchNow);
  const dryOk = dry.status === "ok" && dry.fingerprint === fingerprint(d);
  const blockers = [...list.map((i) => ({ ...i })), ...(dryOk ? [] : [{ id: "dry", step: 4 as const, field: "dry-title", message: dry.status === "fail" ? "El dry-run tiene transacciones que fallarían." : "Falta el dry-run en verde." }])];
  const canLaunch = blockers.length === 0 && launch.status === "idle";
  const scheduled = d.schedule === "at";

  const rows: { k: string; v: string; tip: string; strong?: boolean }[] = [
    { k: "Market cap estimado", v: fmtUsd(est.mcUsd), tip: "precio final de la curva × supply × precio de SOL. Curva de constante producto con reservas virtuales de demostración; en F1 las da el adaptador." },
    { k: "Supply del dev", v: `${est.devPct.toLocaleString("es-ES", { maximumFractionDigits: 2 })} %`, tip: "tokens del dev buy ÷ supply total (1.000 M), tras la fee del pad." },
    { k: "Supply de holders propios", v: `${est.holdersPct.toLocaleString("es-ES", { maximumFractionDigits: 2 })} %`, tip: "suma de tokens de las compras del plan, en orden, sobre la misma curva." },
  ];
  const costs: { k: string; v: number; tip: string }[] = [
    { k: "Dev buy", v: est.dev, tip: "monto del paso 2." },
    { k: "Compras de holders", v: est.holdersSol, tip: "suma de los montos del plan (paso 3)." },
    { k: `Fees de red (${est.txs} tx)`, v: est.network, tip: "5.000 lamports × número de transacciones." },
    { k: "Priority fee", v: est.priority, tip: "priority fee × número de transacciones." },
    { k: "Propina Jito", v: est.jito, tip: "una vez por bundle." },
    { k: `Fee de Pump.fun (${CURVE.padFeePct} %, demo)`, v: est.pad, tip: "porcentaje del pad sobre el volumen de compra; incluido en las compras." },
    { k: "Rent (mint + cuentas)", v: est.rent, tip: "rent del mint más una cuenta de token por wallet compradora. Se recupera al cerrar cuentas vacías." },
    { k: "Colchón (2 %)", v: est.buffer, tip: "margen para variaciones de precio y fees." },
  ];

  return (
    <aside aria-label="Resumen del lanzamiento" className="sticky top-[72px] flex max-h-[calc(100dvh-88px)] flex-col gap-3 overflow-y-auto pb-2 scroll-thin">
      <div className="panel reticle p-4">
        <div className="flex items-center justify-between">
          <p className="telemetry">Resumen</p>
          <SaveChip />
        </div>
        <div className="mt-3 flex items-center gap-3">
          {d.image && !d.image.type.startsWith("video") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={d.image.url} alt="" className="size-12 rounded-[14px] border border-line-strong object-cover" />
          ) : (
            <TokenGlyph symbol={d.symbol || "?"} size={48} />
          )}
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{d.name || "Sin nombre"}</p>
            <p className="num text-[12px] text-muted">{d.symbol ? `$${d.symbol}` : "$—"} · Pump.fun · {d.launchMode === "quick" ? "Quick" : "Manual"}</p>
          </div>
        </div>

        <dl className="mt-4 space-y-1.5 text-[12.5px]">
          {rows.map((r) => (
            <div key={r.k} className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-1 text-muted">
                {r.k} <Tip text={r.tip} />
              </dt>
              <dd className="num">{r.v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3">
          <div className="flex justify-between text-[11.5px] text-muted">
            <span>Hacia la graduación</span>
            <span className="num">
              {est.gradPct.toLocaleString("es-ES", { maximumFractionDigits: 1 })} % de {fmtUsd(CURVE.gradMc)}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-gradient-to-r from-accent-a to-accent-b transition-[width] duration-300" style={{ width: `${est.gradPct}%` }} />
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <p className="telemetry mb-2.5">Coste total</p>
        <dl className="space-y-1.5 text-[12.5px]">
          {costs.map((c) => (
            <div key={c.k} className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-1 text-muted">
                {c.k} <Tip text={c.tip} />
              </dt>
              <dd className="num">{fmtSol(c.v, c.v < 0.01 ? 5 : 3)}</dd>
            </div>
          ))}
          <div className="!mt-2.5 flex items-center justify-between border-t border-line pt-2.5">
            <dt className="font-medium">Total</dt>
            <dd className="num text-[16px] font-medium">{fmtSol(est.total, 3)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="flex items-center gap-1 text-muted">
              Pérdida máxima estimada <Tip text="todo lo gastado en compras, fees y propina si el precio llega a 0. El rent no cuenta porque se recupera." />
            </dt>
            <dd className="num text-sell">{fmtSol(est.maxLoss, 3)}</dd>
          </div>
        </dl>
      </div>

      <div className="panel p-4">
        <p className="telemetry mb-2.5">{blockers.length ? `Falta para lanzar · ${blockers.length}` : "Listo para lanzar"}</p>
        {blockers.length === 0 ? (
          <p className="flex items-center gap-2 text-[12.5px] text-buy">
            <CheckCircle2 className="size-4" aria-hidden /> Todo validado y simulado.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {blockers.map((b) => (
              <li key={b.id} className="flex items-start gap-2 text-[12.5px]">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
                <span className="flex-1 text-muted">{b.message}</span>
                <button onClick={() => goto(b.step, b.field)} className="shrink-0 text-[12px] text-accent-b hover:underline">
                  Corregir
                </button>
              </li>
            ))}
          </ul>
        )}

        {launch.status === "confirmed" ? (
          <div className="mt-4 rounded-[var(--radius-md)] border border-buy/30 bg-[var(--buy-soft)] p-3 text-[12.5px]">
            <p className="flex items-center gap-2 font-medium text-buy">
              <CheckCircle2 className="size-4" aria-hidden /> Token on-chain (simulado)
            </p>
            <p className="num mt-1 text-muted">idempotency · {launch.key}</p>
            <Link href={DEMO_ROUTE} className="cta cta-fill mt-3 flex h-10 items-center justify-center text-[13px] font-semibold">
              Abrir Live Workspace
            </Link>
          </div>
        ) : launch.status === "scheduled" ? (
          <div className="mt-4 rounded-[var(--radius-md)] border border-accent/30 bg-[color-mix(in_oklab,var(--accent-a)_10%,transparent)] p-3 text-[12.5px]">
            <p className="flex items-center gap-2 font-medium">
              <CalendarClock className="size-4 text-accent" aria-hidden /> Programado para {new Date(d.launchAt).toLocaleString("es-ES")}
            </p>
            <p className="mt-1 text-muted">Se puede cancelar hasta T−10 s desde Lanzamientos.</p>
          </div>
        ) : (
          <button onClick={() => launchNow(d)} disabled={!canLaunch} aria-describedby="launch-why" className="cta cta-fill mt-4 flex h-12 w-full items-center justify-center gap-2 text-[14px] font-semibold">
            {launch.status === "pending" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Rocket className="size-4" aria-hidden />}
            {launch.status === "pending" ? "Confirmación pendiente…" : scheduled ? "Programar lanzamiento" : "Lanzar"}
          </button>
        )}
        <p id="launch-why" className="mt-2 text-center text-[11.5px] text-faint">
          {launch.status === "pending" ? "Enviado. Pulsar otra vez no crea un segundo token." : blockers.length ? "Resuelve la lista para habilitar el lanzamiento." : "Prototipo: no se envía nada a la red."}
        </p>
      </div>
    </aside>
  );
}
