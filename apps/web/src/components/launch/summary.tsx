"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Activity, AlertCircle, CalendarClock, Check, CheckCircle2, CircleDashed, CircleSlash, CloudOff, Info, Loader2, PauseCircle, Rocket, XCircle } from "lucide-react";
import { Address } from "@/components/address";
import { api } from "@/lib/api";
import { fmtMs, issues, planAmounts, toLamports, useDraft, HOLDER_BUFFER } from "@/lib/draft";
import { fingerprint, useLaunchRun } from "@/lib/launch-run";
import { fmtLamports, useChain } from "@/lib/chain";
import { TokenGlyph } from "@/components/live/token-header";
import { useLaunchData } from "./use-launch-data";

function Tip({ text }: { text: string }) {
  const id = useId();
  return (
    <span className="group relative inline-flex">
      <button type="button" aria-describedby={id} aria-label="Ver cómo se calcula" className="grid size-4 place-items-center rounded text-faint hover:text-fg">
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

type Quote = { devTokens: string; buyTokens: string[]; supply: string; marketCapLamports: string; graduationPct: number; padFeeBps: number };
const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 1_000_000n) / whole) / 10_000 : 0);

/** REQ-LAUNCH-011: estimaciones calculadas por el adaptador (sin constantes de demostración). */
function useQuote(devBuy: bigint, buys: bigint[]) {
  const [q, setQ] = useState<Quote | null>(null);
  const key = `${devBuy}|${buys.join(",")}`;
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api<Quote>("/launches/quote", { method: "POST", body: { devBuyLamports: devBuy.toString(), buys: buys.map(String) } })
        .then((r) => alive && setQ(r))
        .catch(() => alive && setQ(null));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` resume devBuy y buys
  }, [key]);
  return q;
}

export function LaunchSummary({ goto }: { goto: (step: number, field?: string) => void }) {
  const d = useDraft((s) => s.draft);
  const { balances, addressOf } = useLaunchData();
  const chainOff = useChain((s) => s.status?.mode === "off");
  const list = issues(d, { balances, addressOf });
  const view = useLaunchRun((s) => s.view);
  const fp = useLaunchRun((s) => s.fp);
  const busy = useLaunchRun((s) => s.busy);
  const launch = useLaunchRun((s) => s.launch);
  const resume = async () => {
    if (!view) return;
    await api(`/launches/${view.id}/resume`, { method: "POST", body: {} });
    await useLaunchRun.getState().load(view.id);
  };
  const devBuy = toLamports(d.devBuy);
  const amounts = planAmounts(d);
  const q = useQuote(devBuy, amounts);
  const supply = q ? BigInt(q.supply) : 0n;
  const devTokens = q ? BigInt(q.devTokens) : 0n;
  const holderTokens = q ? q.buyTokens.reduce((a, t) => a + BigInt(t), 0n) : 0n;
  const holdersSol = amounts.reduce((a, l) => a + l, 0n);
  const launched = view && view.status !== "PREPARED" && view.status !== "FAILED";
  const dryOk = !!view?.preflight?.ok && fp === fingerprint(d);
  // El dry-run del servidor (simulación real + saldos) manda sobre la estimación de fondos del navegador
  const blockers = [...list.filter((i) => !(dryOk && i.id === "funding")), ...(dryOk || launched ? [] : [{ id: "dry", step: 4 as const, field: "dry-title", message: view?.preflight && !view.preflight.ok ? "El dry-run tiene comprobaciones pendientes." : "Falta el dry-run en verde." }])];
  const canLaunch = blockers.length === 0 && !launched && !chainOff;

  const rows: { k: string; v: string; tip: string }[] = [
    { k: "Market cap estimado", v: q ? fmtLamports(BigInt(q.marketCapLamports), 2) : "—", tip: "Reservas de la curva tras el dev buy y las compras del plan, calculadas por el adaptador de Pump.fun. En SOL: no hay fuente de precio en USD." },
    { k: "Supply del dev", v: q ? `${pct(devTokens, supply).toLocaleString("es-ES", { maximumFractionDigits: 2 })} %` : "—", tip: "Tokens del dev buy ÷ supply total, con las fees del programa." },
    { k: "Supply de holders propios", v: q ? `${pct(holderTokens, supply).toLocaleString("es-ES", { maximumFractionDigits: 2 })} %` : "—", tip: "Suma de las compras del plan, en orden, sobre la misma curva." },
  ];
  const fee5k = 5_000n;
  const costs: { k: string; v: bigint; tip: string }[] = [
    { k: "Dev buy", v: devBuy, tip: "Monto del paso 2 (incluye la fee del pad)." },
    { k: "Compras de holders", v: holdersSol, tip: "Suma de los montos del plan (paso 3)." },
    { k: `Firmas (${2 + amounts.length})`, v: fee5k * BigInt(2 + amounts.length), tip: "5.000 lamports por firma: creador + mint en la creación, y una por compra." },
    { k: "Cuentas de token de holders", v: (HOLDER_BUFFER - 500_000n) * BigInt(amounts.length), tip: "Estimado: rent de la cuenta de token de cada holder (recuperable al cerrarla) + priority fee." },
  ];
  const total = costs.reduce((a, c) => a + c.v, 0n);

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
            <p className="num text-[12px] text-muted">
              {d.symbol ? `$${d.symbol}` : "$—"} · Pump.fun · {d.launchMode === "quick" ? "Quick" : d.launchMode === "pro" ? "Pro" : "Manual"}
            </p>
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
            <span className="num">{q ? `${q.graduationPct.toLocaleString("es-ES", { maximumFractionDigits: 1 })} %` : "—"}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-gradient-to-r from-accent-a to-accent-b transition-[width] duration-300" style={{ width: `${q?.graduationPct ?? 0}%` }} />
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <p className="telemetry mb-2.5">Coste estimado</p>
        <dl className="space-y-1.5 text-[12.5px]">
          {costs.map((c) => (
            <div key={c.k} className="flex items-center justify-between gap-2">
              <dt className="flex items-center gap-1 text-muted">
                {c.k} <Tip text={c.tip} />
              </dt>
              <dd className="num">{fmtLamports(c.v, c.v < 10_000_000n ? 6 : 3)}</dd>
            </div>
          ))}
          <div className="!mt-2.5 flex items-center justify-between border-t border-line pt-2.5">
            <dt className="font-medium">Total aproximado</dt>
            <dd className="num text-[16px] font-medium">{fmtLamports(total, 4)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[11.5px] text-faint">Más el rent de creación (mint y curva) y la priority fee de Ajustes. Fee del pad: {q ? `${(q.padFeeBps / 100).toLocaleString("es-ES")} %` : "—"}, incluida en las compras.</p>
      </div>

      <div className="panel p-4">
        {!launched ? (
          <>
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
            {view?.status === "FAILED" && view.error && <p className="mt-3 rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-2.5 text-[12.5px] text-sell">La creación falló: {view.error}. No se creó ningún token; corrige y vuelve a simular.</p>}
            {view?.schedule ? (
              <ScheduledCard />
            ) : (
              <>
                <button onClick={() => launch(d)} disabled={!canLaunch || busy === "launch"} aria-describedby="launch-why" className="cta cta-fill mt-4 flex h-12 w-full items-center justify-center gap-2 text-[14px] font-semibold">
                  {busy === "launch" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Rocket className="size-4" aria-hidden />}
                  {busy === "launch" ? "Enviando…" : "Lanzar"}
                </button>
                <p id="launch-why" className="mt-2 text-center text-[11.5px] text-faint">
                  {chainOff ? "Sin RPC configurado." : blockers.length ? "Resuelve la lista para habilitar el lanzamiento." : "Se crea el token con el dev buy y luego compran los holders en orden."}
                </p>
                <ScheduleForm disabled={!canLaunch} />
              </>
            )}
          </>
        ) : (
          <LaunchResult />
        )}
        {view?.status === "PAUSED" && (
          <button onClick={resume} className="btn mt-3 h-9 w-full">
            <PauseCircle className="size-4" aria-hidden /> Reanudar el lanzamiento
          </button>
        )}
      </div>
    </aside>
  );
}

function LaunchResult() {
  const view = useLaunchRun((s) => s.view)!;
  const steps = view.status === "PAUSED" ? "En pausa" : view.status === "DONE" ? "Lanzado" : view.status === "CREATING" ? "Creando el token…" : view.status === "BUYING" ? "Compras de holders…" : "Confirmación pendiente…";
  const ok = view.buys.filter((b) => b.status === "OK").length;
  return (
    <div aria-live="polite">
      <p className="telemetry mb-2">Lanzamiento</p>
      <p className={`flex items-center gap-2 text-[14px] font-semibold ${view.status === "DONE" ? "text-buy" : view.status === "PAUSED" ? "text-warn" : ""}`}>
        {view.status === "DONE" ? <CheckCircle2 className="size-4" aria-hidden /> : view.status === "PAUSED" ? <PauseCircle className="size-4" aria-hidden /> : <Loader2 className="size-4 animate-spin" aria-hidden />}
        {steps}
      </p>
      <dl className="mt-3 space-y-1.5 text-[12px]">
        <div className="flex justify-between gap-2">
          <dt className="text-muted">Mint</dt>
          <dd>
            <Address value={view.mint} kind="token" head={6} tail={6} />
          </dd>
        </div>
        {view.createSignature && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Creación + dev buy</dt>
            <dd>
              <Address value={view.createSignature} kind="tx" head={6} tail={4} />
            </dd>
          </div>
        )}
      </dl>
      {view.mode !== "manual" && (
        <>
          <p className="mt-3 mb-1.5 text-[12px] text-muted">
            Compras · {ok}/{view.buys.length}
          </p>
          <ul className="scroll-thin max-h-48 space-y-1 overflow-y-auto">
            {view.buys.map((b) => (
              <li key={b.ord} className="flex items-center gap-2 text-[12px]">
                {b.status === "OK" ? <CheckCircle2 className="size-3.5 text-buy" aria-label="entró" /> : b.status === "FAILED" ? <XCircle className="size-3.5 text-sell" aria-label="falló" /> : b.status === "SKIPPED" ? <CircleSlash className="size-3.5 text-faint" aria-label="omitida" /> : <Loader2 className="size-3.5 animate-spin text-muted" aria-label="pendiente" />}
                <span className="w-24 truncate">{b.label}</span>
                <span className="num text-muted">{fmtLamports(BigInt(b.lamports), 3)}</span>
                {view.mode === "pro" && <span className="num text-faint">espera {fmtMs(b.delayMs ?? 0)}</span>}
                {b.sentAfterMs != null && <span className="num text-faint" title="Momento real del envío, desde la confirmación de la creación">T+{fmtMs(b.sentAfterMs)}</span>}
                {b.reason && <span className="truncate text-sell">{b.reason}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {/* El token ya existe en cadena desde CREATED: su Live Workspace lee datos reales */}
      {["CREATED", "BUYING", "DONE", "PAUSED"].includes(view.status) && view.createSignature && (
        <Link href={`/t/${view.mint}`} className="cta cta-fill mt-4 flex h-11 w-full items-center justify-center gap-2 text-[13.5px] font-semibold">
          <Activity className="size-4" aria-hidden /> Abrir en Live
        </Link>
      )}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** REQ-LAUNCH-015: programar con la misma validación que «Lanzar» (dry-run en verde). */
function ScheduleForm({ disabled }: { disabled: boolean }) {
  const d = useDraft((s) => s.draft);
  const busy = useLaunchRun((s) => s.busy);
  const schedule = useLaunchRun((s) => s.schedule);
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(() => toLocalInput(Date.now() + 5 * 60_000));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const at = new Date(when).getTime();
  const tooSoon = !Number.isFinite(at) || at < now + 20_000;
  if (!open)
    return (
      <button onClick={() => setOpen(true)} disabled={disabled} className="btn mt-2 h-9 w-full text-[12.5px]">
        <CalendarClock className="size-3.5" aria-hidden /> Programar para más tarde
      </button>
    );
  return (
    <div className="mt-3 rounded-[var(--radius-md)] border border-line bg-surface-2/50 p-3">
      <label htmlFor="launch-at" className="mb-1.5 block text-[12px] font-medium">
        Lanzar a esta hora (local)
      </label>
      <input id="launch-at" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="field num h-9 text-[12.5px]" aria-invalid={tooSoon} />
      <p className="mt-1.5 text-[11px] text-faint">Se guarda en este equipo y se lanza aunque reinicies la app, si la bóveda está abierta a esa hora. Si está bloqueada, queda en pausa hasta que confirmes. Cancelable hasta 10 s antes.</p>
      <div className="mt-2.5 flex gap-2">
        <button onClick={() => setOpen(false)} className="btn h-8 flex-1 text-[12px]">
          Cancelar
        </button>
        <button onClick={() => schedule(d, at)} disabled={disabled || tooSoon || busy !== null} className="cta cta-fill flex h-8 flex-1 items-center justify-center gap-1.5 text-[12px] font-semibold">
          {busy === "schedule" && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Programar
        </button>
      </div>
    </div>
  );
}

function ScheduledCard() {
  const view = useLaunchRun((s) => s.view)!;
  const busy = useLaunchRun((s) => s.busy);
  const cancel = useLaunchRun((s) => s.cancelSchedule);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = view.schedule!;
  const left = Math.max(0, Math.round((s.at - now) / 1000));
  const canCancel = s.state !== "WAITING" || now < s.cancellableUntil;
  return (
    <div aria-live="polite" className={`mt-4 rounded-[var(--radius-md)] border p-3 ${s.state === "FAILED" ? "border-sell/30 bg-[var(--sell-soft)]" : s.state === "PAUSED" ? "border-warn/30 bg-[var(--warn-soft)]" : "border-accent-b/30 bg-surface-2/60"}`}>
      <p className="flex items-center gap-2 text-[13px] font-semibold">
        <CalendarClock className="size-4 text-accent-b" aria-hidden />
        {s.state === "WAITING" ? "Programado" : s.state === "PAUSED" ? "Programado · en pausa" : "No se lanzó a su hora"}
      </p>
      <p className="num mt-1 text-[12px] text-muted">{new Date(s.at).toLocaleString("es-ES", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</p>
      {s.state === "WAITING" && (
        <p className="num mt-2 text-[22px] leading-none">
          {pad(Math.floor(left / 3600))}:{pad(Math.floor((left % 3600) / 60))}:{pad(left % 60)}
        </p>
      )}
      {s.state === "PAUSED" && <p className="mt-2 text-[12px] text-warn">{s.error ?? "En pausa."} Confírmalo desde el aviso de tareas en pausa o desde Lanzamientos: se lanzará al momento.</p>}
      {s.state === "FAILED" && s.error && <p className="mt-2 text-[12px] text-sell">{s.error}</p>}
      <button onClick={() => cancel(view.id)} disabled={!canCancel || busy !== null} className="btn mt-3 h-8 w-full text-[12px]">
        {busy === "schedule" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <XCircle className="size-3.5" aria-hidden />}
        {canCancel ? (s.state === "WAITING" ? "Cancelar la programación" : "Quitar la programación") : "Ya no se puede cancelar"}
      </button>
    </div>
  );
}
