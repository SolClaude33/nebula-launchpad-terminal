"use client";

// / · Dashboard y P&L (REQ-DASH-001/002/005). Todo sale de la API local: trades propios indexados y
// transacciones propias con la fee real leída de la cadena. El P&L descuenta las fees de red, la
// propina Jito y las fees de Pump.fun; el rent de cuentas se muestra aparte porque es recuperable.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowDownRight, ArrowUpRight, Landmark, Layers, Rocket, Trophy, Wallet } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { fmtPct, fmtSol, fmtUsd, shortAddr, timeAgo } from "@/lib/format";
import type { Point } from "@/components/dashboard/pnl-charts";

// Los gráficos no entran en el JS inicial (§8.6)
const CumulativeChart = dynamic(() => import("@/components/dashboard/pnl-charts").then((m) => m.CumulativeChart), { ssr: false, loading: () => <div className="skeleton h-[168px]" /> });
const DailyBars = dynamic(() => import("@/components/dashboard/pnl-charts").then((m) => m.DailyBars), { ssr: false, loading: () => <div className="skeleton h-[168px]" /> });
const Starfield = dynamic(() => import("@/components/starfield").then((m) => m.Starfield), { ssr: false });

export type Period = "24h" | "7d" | "30d" | "1y" | "all";
type LaunchRow = { id: string; mint: string; name: string; symbol: string; status: string; createdAt: number; pnlLamports: number; realizedLamports: number; unrealizedLamports: number; feesLamports: number; investedLamports: number };
export type Dashboard = {
  period: Period;
  solUsd: { usd: number; publishedAt: number } | null;
  balances: { totalLamports: string; funderLamports: string; walletsLamports: string; wallets: number };
  totals: { pnlLamports: number; realizedLamports: number; unrealizedLamports: number; buysLamports: number; sellsLamports: number; padFeesLamports: number; networkFeesLamports: number; jitoLamports: number; rentLamports: number; claimsLamports: number; trades: number };
  winRate: { wins: number; total: number };
  avgPerLaunchLamports: number | null;
  series: { t: number; pnlLamports: number; cumLamports: number }[];
  bucket: "hour" | "day";
  launches: LaunchRow[];
  counts: { wallets: number; funders: number; launches: number; drafts: number };
  indexing: { pending: number };
  at: number;
};

const PERIODS: [Period, string][] = [
  ["24h", "24 H"],
  ["7d", "7 D"],
  ["30d", "30 D"],
  ["1y", "1 A"],
  ["all", "Todo"],
];

const load = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

export function DashboardView() {
  const [period, setPeriod] = useState<Period>("30d");
  const [unit, setUnit] = useState<"sol" | "usd">("sol");
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- preferencias locales leídas tras montar
    setPeriod(load("nebula.dash.period", "30d") as Period);
    setUnit(load("nebula.dash.unit", "sol") === "usd" ? "usd" : "sol");
  }, []);

  useEffect(() => {
    let alive = true;
    const get = () =>
      api<Dashboard>(`/dashboard?period=${period}&tz=${new Date().getTimezoneOffset()}`).then(
        (d) => alive && (setData(d), setError(null)),
        (e) => alive && setError((e as ApiError).message),
      );
    void get();
    const id = setInterval(get, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [period]);

  const usd = data?.solUsd?.usd ?? null;
  const showUsd = unit === "usd" && usd !== null;
  const fmt = useMemo(() => (l: number, signed = false) => {
    const sol = l / 1e9 || 0; // sin «-0»
    const sign = signed && sol > 0 ? "+" : "";
    return showUsd ? `${sign}${fmtUsd(sol * usd!, false)}` : `${sign}${fmtSol(sol, Math.abs(sol) >= 100 ? 2 : 4)}`;
  }, [showUsd, usd]);
  const fmtAxis = useMemo(() => (l: number) => {
    const v = (l / 1e9) * (showUsd ? usd! : 1);
    return `${showUsd ? "$" : ""}${v.toLocaleString("es-ES", { maximumFractionDigits: Math.abs(v) >= 10 ? 0 : 3 })}`;
  }, [showUsd, usd]);

  if (error && !data) return <p className="m-6 rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-3 text-[12.5px] text-sell">{error}</p>;
  if (!data)
    return (
      <div className="mx-auto max-w-[1180px] space-y-4 p-6" aria-busy="true">
        <div className="skeleton h-10 w-60" />
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-28" />
          ))}
        </div>
        <div className="skeleton h-72" />
      </div>
    );

  const empty = data.counts.launches === 0 && data.totals.trades === 0;
  if (empty) return <EmptyState d={data} />;

  const label = (t: number) => (data.bucket === "hour" ? new Date(t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }) : new Date(t).toLocaleDateString("es-ES", { day: "2-digit", month: "short" }));
  const cum: Point[] = data.series.map((p) => ({ t: p.t, label: label(p.t), v: p.cumLamports }));
  const daily: Point[] = data.series.map((p) => ({ t: p.t, label: label(p.t), v: p.pnlLamports }));
  const best = [...data.launches].sort((a, b) => b.pnlLamports - a.pnlLamports).slice(0, 5);
  const recent = [...data.launches].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  const t = data.totals;
  const wr = data.winRate.total ? (data.winRate.wins / data.winRate.total) * 100 : null;

  return (
    <div className="mx-auto max-w-[1180px] p-6 pb-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="telemetry">Operar</p>
          <h1 className="font-display mt-1 text-[30px] tracking-[-0.01em]">Dashboard</h1>
        </div>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Período" className="inline-flex gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
            {PERIODS.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={period === k} onClick={() => (setPeriod(k), store("nebula.dash.period", k))} className={`num h-7 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors ${period === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
                {l}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Unidad" className="inline-flex gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
            {(["sol", "usd"] as const).map((u) => (
              <button key={u} role="radio" aria-checked={unit === u} disabled={u === "usd" && usd === null} title={u === "usd" ? (usd ? "Al precio SOL/USD actual (Pyth)" : "Sin precio SOL/USD") : undefined} onClick={() => (setUnit(u), store("nebula.dash.unit", u))} className={`num h-7 rounded-[6px] px-2.5 text-[12px] font-medium uppercase transition-colors disabled:opacity-40 ${unit === u ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
                {u}
              </button>
            ))}
          </div>
        </div>
      </div>
      {showUsd && <p className="mt-1 text-right text-[11px] text-faint">USD al precio actual (Pyth {fmtUsd(usd!, false)}); no hay precio histórico.</p>}
      {data.indexing.pending > 0 && <p className="mt-2 text-[12px] text-warn">Indexando {data.indexing.pending} transacciones propias; las cifras se completan en unos segundos.</p>}

      <div className="mt-5 grid grid-cols-4 gap-4">
        <Kpi label="P&L del período" value={fmt(t.pnlLamports, true)} tone={t.pnlLamports >= 0 ? "buy" : "sell"} sub={`Abierto aparte: ${fmt(t.unrealizedLamports, true)} al precio actual`} />
        <Kpi label="Saldo total" value={fmt(Number(data.balances.totalLamports))} sub={`Funder ${fmt(Number(data.balances.funderLamports))} · ${data.balances.wallets} wallets`} />
        <Kpi label="Win rate" value={wr === null ? "—" : fmtPct(wr, 0)} sub={data.winRate.total ? `${data.winRate.wins} de ${data.winRate.total} tokens con ventas` : "Sin ventas en el período"} />
        <Kpi label="P&L medio por lanzamiento" value={data.avgPerLaunchLamports === null ? "—" : fmt(data.avgPerLaunchLamports, true)} tone={data.avgPerLaunchLamports === null ? undefined : data.avgPerLaunchLamports >= 0 ? "buy" : "sell"} sub={`${data.counts.launches} lanzamientos`} />
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_300px] gap-4">
        <section aria-labelledby="perf-t" className="panel reticle p-5">
          <div className="flex items-baseline justify-between">
            <h2 id="perf-t" className="text-[14px] font-semibold">
              Rendimiento acumulado
            </h2>
            <span className="telemetry">realizado − fees + comisiones</span>
          </div>
          <div className="mt-3">{cum.length ? <CumulativeChart points={cum} fmt={(v) => fmt(v, true)} fmtAxis={fmtAxis} /> : <NoData />}</div>
          <div className="mt-5 flex items-baseline justify-between">
            <h2 className="text-[14px] font-semibold">P&L por {data.bucket === "hour" ? "hora" : "día"}</h2>
          </div>
          <div className="mt-3">{daily.length ? <DailyBars points={daily} fmt={(v) => fmt(v, true)} fmtAxis={fmtAxis} /> : <NoData />}</div>
          {daily.length > 0 && (
            <details className="mt-3 text-[12px]">
              <summary className="cursor-pointer text-muted hover:text-fg">Ver como tabla</summary>
              <table className="num mt-2 w-full text-[12px]">
                <thead className="text-faint">
                  <tr>
                    <th className="py-1 text-left font-normal">Intervalo</th>
                    <th className="py-1 text-right font-normal">P&L</th>
                    <th className="py-1 text-right font-normal">Acumulado</th>
                  </tr>
                </thead>
                <tbody>
                  {data.series.map((p) => (
                    <tr key={p.t} className="border-t border-line">
                      <td className="py-1">{label(p.t)}</td>
                      <td className="py-1 text-right">{fmt(p.pnlLamports, true)}</td>
                      <td className="py-1 text-right">{fmt(p.cumLamports, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </section>

        <section aria-labelledby="break-t" className="panel p-5">
          <h2 id="break-t" className="text-[14px] font-semibold">
            Desglose del período
          </h2>
          <dl className="mt-3 space-y-2 text-[12.5px]">
            <Row k="Ventas" v={fmt(t.sellsLamports)} />
            <Row k="Compras" v={fmt(-t.buysLamports)} hint="Incluye las fees de Pump.fun y PumpSwap" />
            <Row k="· de ellas, fees del pad" v={fmt(-t.padFeesLamports)} muted />
            <Row k="Fees de red" v={fmt(-t.networkFeesLamports)} hint="Leídas de cada transacción en cadena" />
            <Row k="Propinas Jito" v={fmt(-t.jitoLamports)} />
            <Row k="Comisiones reclamadas" v={fmt(t.claimsLamports)} />
            <Row k="Realizado (coste medio)" v={fmt(t.realizedLamports, true)} muted hint="Ventas menos el coste base de lo vendido" />
            <div className="border-t border-line pt-2">
              <Row k="P&L" v={fmt(t.pnlLamports, true)} strong hint="Realizado − fees de red − Jito + comisiones" />
            </div>
            <Row k="Posición abierta (al precio actual)" v={fmt(t.unrealizedLamports, true)} muted />
            <Row k="Rent en cuentas (recuperable, aparte)" v={fmt(-t.rentLamports)} muted hint="Cuentas de token y de volumen que crean las compras y la creación del token" />
            <Row k="Trades propios" v={String(t.trades)} muted />
          </dl>
        </section>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <LaunchTable title="Mejores lanzamientos" icon={<Trophy className="size-4 text-accent-b" aria-hidden />} rows={best} fmt={fmt} />
        <LaunchTable title="Lanzamientos recientes" icon={<Rocket className="size-4 text-accent-b" aria-hidden />} rows={recent} fmt={fmt} recent />
      </div>
    </div>
  );
}

function NoData() {
  return <p className="grid h-[120px] place-items-center rounded-[var(--radius-sm)] border border-dashed border-line text-[12.5px] text-faint">Sin movimientos en este período</p>;
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "buy" | "sell" }) {
  return (
    <div className="panel hover-glow p-4">
      <p className="telemetry">{label}</p>
      <p className={`num mt-2 flex items-center gap-1.5 text-[22px] leading-none ${tone === "buy" ? "text-buy" : tone === "sell" ? "text-sell" : ""}`}>
        {tone === "buy" && <ArrowUpRight className="size-4" aria-label="ganancia" />}
        {tone === "sell" && <ArrowDownRight className="size-4" aria-label="pérdida" />}
        {value}
      </p>
      {sub && <p className="num mt-2 truncate text-[11.5px] text-faint" title={sub}>{sub}</p>}
    </div>
  );
}

function Row({ k, v, hint, muted, strong }: { k: string; v: string; hint?: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={hint}>
      <dt className={muted ? "text-faint" : "text-muted"}>{k}</dt>
      <dd className={`num ${strong ? "text-[14px] font-semibold text-fg" : muted ? "text-faint" : "text-fg"}`}>{v}</dd>
    </div>
  );
}

function LaunchTable({ title, icon, rows, fmt, recent }: { title: string; icon: React.ReactNode; rows: LaunchRow[]; fmt: (l: number, s?: boolean) => string; recent?: boolean }) {
  return (
    <section className="panel p-5" aria-label={title}>
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold">
          {icon}
          {title}
        </h2>
        <Link href="/launches" className="text-[12px] text-muted hover:text-fg">
          Ver todos
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-[12.5px] text-faint">Aún no hay lanzamientos.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/t/${r.mint}`} className="flex items-center gap-3 py-2.5 transition-colors hover:text-fg">
                <span className="grid size-8 shrink-0 place-items-center rounded-full border border-line bg-surface-2 text-[11px] font-semibold">{r.symbol.slice(0, 3)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    ${r.symbol} <span className="font-normal text-muted">{r.name}</span>
                  </span>
                  <span className="num block text-[11px] text-faint">
                    {shortAddr(r.mint)} · {recent ? `hace ${timeAgo(r.createdAt)}` : `invertido ${fmt(r.investedLamports)}`}
                  </span>
                </span>
                <span className={`num text-[13px] ${r.pnlLamports >= 0 ? "text-buy" : "text-sell"}`}>
                  {r.pnlLamports >= 0 ? "▲" : "▼"} {fmt(r.pnlLamports, true)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** REQ-DASH-005: guía hacia la primera wallet, el funder y el primer lanzamiento. */
function EmptyState({ d }: { d: Dashboard }) {
  const steps = [
    { done: d.counts.funders > 0, title: "Crea un funder y deposita SOL", body: "La wallet desde la que se financia todo. Su dirección y QR están en Funder.", href: "/funder", cta: "Ir a Funder", icon: Landmark },
    { done: d.counts.wallets > 0, title: "Crea tus wallets", body: "Una dev para lanzar y las holder que compran en el modo Quick.", href: "/wallets", cta: "Crear wallets", icon: Wallet },
    { done: d.counts.launches > 0, title: "Lanza tu primer token", body: d.counts.drafts ? `Tienes ${d.counts.drafts} borrador${d.counts.drafts === 1 ? "" : "es"} esperando.` : "Asistente de 4 pasos con dry-run antes de enviar nada.", href: d.counts.drafts ? "/launches/drafts" : "/launch/new", cta: d.counts.drafts ? "Ver borradores" : "Lanzar token", icon: Rocket },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <div className="relative mx-auto max-w-[1180px] p-6">
      <div className="panel reticle relative overflow-hidden p-10">
        <div className="pointer-events-none absolute inset-0 opacity-60" aria-hidden>
          <Starfield />
        </div>
        <div className="relative">
          <p className="telemetry">Dashboard</p>
          <h1 className="font-display mt-2 text-[40px] leading-[1.05] tracking-[-0.01em]">Tu observatorio está listo.</h1>
          <p className="mt-2 max-w-[520px] text-[13.5px] text-muted">Aquí verás el P&L de tus lanzamientos, fees incluidas, en cuanto haya movimientos. Tres pasos para empezar:</p>
          <ol className="mt-7 grid grid-cols-3 gap-4">
            {steps.map((s, i) => {
              const Icon = s.icon;
              return (
                <li key={s.title} className={`rounded-[var(--radius-md)] border p-4 backdrop-blur-md ${i === next ? "border-accent-b/40 bg-surface-2/80" : "border-line bg-surface-2/50"}`}>
                  <div className="flex items-center gap-2">
                    <span className={`num grid size-6 place-items-center rounded-full text-[11px] ${s.done ? "bg-[var(--buy-soft)] text-buy" : "border border-line-strong"}`}>{s.done ? "✓" : i + 1}</span>
                    <Icon className="size-4 text-muted" aria-hidden />
                  </div>
                  <p className="mt-3 text-[13.5px] font-semibold">{s.title}</p>
                  <p className="mt-1 text-[12px] text-muted">{s.body}</p>
                  <Link href={s.href} className={`mt-4 inline-flex h-8 items-center gap-1.5 px-3 text-[12px] font-semibold ${i === next ? "cta cta-fill" : "btn"}`}>
                    {s.cta}
                  </Link>
                </li>
              );
            })}
          </ol>
          <p className="mt-6 flex items-center gap-2 text-[12px] text-faint">
            <Layers className="size-3.5" aria-hidden /> ¿Ya tienes un token de Pump.fun? Ábrelo en Live para operarlo desde tus wallets.
          </p>
        </div>
      </div>
    </div>
  );
}
