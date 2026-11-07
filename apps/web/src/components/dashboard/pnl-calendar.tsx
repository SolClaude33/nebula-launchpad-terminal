"use client";

// REQ-DASH-003: calendario de P&L (mes por días o año por meses), con los mismos movimientos que el
// dashboard: realizado − fees de red − Jito + comisiones, en hora local. Rejilla CSS, sin librería de gráficos.
import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { api, ApiError } from "@/lib/api";

type Cell = { index: number; pnlLamports: number; moves: number };
type Calendar = { year: number; month: number | null; firstWeekday: number | null; cells: Cell[]; totalLamports: number; positive: number; negative: number; firstMoveAt: number | null };

const WEEK = ["L", "M", "X", "J", "V", "S", "D"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function PnlCalendar({ fmt }: { fmt: (l: number, signed?: boolean) => string }) {
  const today = new Date();
  const [mode, setMode] = useState<"month" | "year">("month");
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [data, setData] = useState<Calendar | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const q = `year=${year}${mode === "month" ? `&month=${month}` : ""}&tz=${new Date().getTimezoneOffset()}`;
    api<Calendar>(`/dashboard/calendar?${q}`).then(
      (d) => alive && (setData(d), setError(null)),
      (e) => alive && setError((e as ApiError).message),
    );
    return () => {
      alive = false;
    };
  }, [mode, year, month]);

  const step = (d: number) => {
    if (mode === "year") return setYear((y) => y + d);
    const m = month + d;
    if (m < 1) {
      setMonth(12);
      setYear((y) => y - 1);
    } else if (m > 12) {
      setMonth(1);
      setYear((y) => y + 1);
    } else setMonth(m);
  };
  const isFuture = mode === "year" ? year >= today.getFullYear() : year > today.getFullYear() || (year === today.getFullYear() && month >= today.getMonth() + 1);
  const title = mode === "year" ? String(year) : `${MONTHS[month - 1]} ${year}`;
  const max = Math.max(1, ...(data?.cells ?? []).map((c) => Math.abs(c.pnlLamports)));
  // La rejilla se pinta según los DATOS (no el modo pedido): al cambiar de vista, la respuesta anterior sigue
  // en pantalla hasta que llega la nueva y sus celdas no corresponden a la vista nueva.
  const yearView = data ? data.month === null : mode === "year";
  const cellName = (c: Cell) => (yearView ? `${MONTHS[c.index - 1]} ${data?.year}` : `${c.index} de ${MONTHS[(data?.month ?? month) - 1]}`);

  return (
    <section aria-labelledby="cal-t" className="panel mt-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="cal-t" className="flex items-center gap-2 text-[14px] font-semibold">
          <CalendarDays className="size-4 text-accent-b" aria-hidden /> Calendario de P&L
        </h2>
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label="Vista del calendario" className="inline-flex gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
            {(
              [
                ["month", "Mes"],
                ["year", "Año"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} role="radio" aria-checked={mode === k} onClick={() => setMode(k)} className={`h-7 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors ${mode === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
                {l}
              </button>
            ))}
          </div>
          <button onClick={() => step(-1)} aria-label={mode === "year" ? "Año anterior" : "Mes anterior"} className="btn grid size-8 place-items-center p-0">
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <span className="w-[132px] text-center text-[13px] font-medium capitalize" aria-live="polite">
            {title}
          </span>
          <button onClick={() => step(1)} disabled={isFuture} aria-label={mode === "year" ? "Año siguiente" : "Mes siguiente"} className="btn grid size-8 place-items-center p-0 disabled:opacity-40">
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-[12.5px] text-sell">{error}</p>}
      {!data ? (
        <div className="skeleton mt-4 h-[220px]" aria-busy="true" />
      ) : (
        <>
          <div className={`mt-4 grid gap-1.5 ${!yearView ? "grid-cols-7" : "grid-cols-6"}`}>
            {!yearView &&
              WEEK.map((w) => (
                <span key={w} aria-hidden className="telemetry pb-1 text-center">
                  {w}
                </span>
              ))}
            {!yearView && Array.from({ length: data.firstWeekday ?? 0 }, (_, i) => <span key={`pad-${i}`} aria-hidden />)}
            {data.cells.map((c) => {
              const tone = c.moves === 0 ? null : c.pnlLamports >= 0 ? "buy" : "sell";
              const pct = tone ? Math.round(12 + (Math.abs(c.pnlLamports) / max) * 28) : 0;
              const label = `${cellName(c)}: ${c.moves === 0 ? "sin movimientos" : fmt(c.pnlLamports, true)}`;
              return (
                <div
                  key={c.index}
                  role="img"
                  aria-label={label}
                  title={label}
                  className={`flex flex-col justify-between rounded-[var(--radius-sm)] border p-2 ${!yearView ? "h-[62px]" : "h-[72px]"} ${tone ? "border-transparent" : "border-line/60"}`}
                  style={tone ? { background: `color-mix(in oklab, var(--${tone}) ${pct}%, transparent)` } : undefined}
                >
                  <span className={`text-[11px] ${tone ? "text-fg/80" : "text-faint"} ${yearView ? "capitalize" : ""}`}>{yearView ? MONTHS[c.index - 1].slice(0, 3) : c.index}</span>
                  {tone && <span className="num truncate text-[11.5px] font-medium text-fg">{fmt(c.pnlLamports, true)}</span>}
                </div>
              );
            })}
          </div>
          <div className="num mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-muted">
            <span>
              Total {yearView ? "del año" : "del mes"}: <span className={data.totalLamports > 0 ? "text-buy" : data.totalLamports < 0 ? "text-sell" : "text-fg"}>{fmt(data.totalLamports, true)}</span>
            </span>
            <span>
              {data.positive} {yearView ? "meses" : "días"} en positivo · {data.negative} en negativo
            </span>
            <span className="text-faint">Realizado − fees de red − Jito + comisiones, en tu hora local</span>
          </div>
        </>
      )}
    </section>
  );
}
