"use client";

// REQ-DASH-001: rendimiento acumulado (línea) y P&L por día u hora (barras con polaridad).
// SVG propio: sin librerías de gráficos (presupuesto de JS, §8.6). Cada gráfico tiene un solo eje,
// rejilla tenue, marcas finas y una capa de hover con cruz y tooltip; los valores van en tinta de texto.
import { useId, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

export type Point = { t: number; label: string; v: number };

const W = 640;
const H = 168;
const PAD = { l: 56, r: 12, t: 12, b: 24 };

function ticks(min: number, max: number, n = 4) {
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function useScale(points: Point[], includeZero = true) {
  return useMemo(() => {
    const vs = points.map((p) => p.v);
    let lo = Math.min(...vs, includeZero ? 0 : Infinity);
    let hi = Math.max(...vs, includeZero ? 0 : -Infinity);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    if (lo === hi) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= lo < 0 ? pad : 0;
    hi += pad;
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    return { lo, hi, y, ticks: ticks(lo, hi) };
  }, [points, includeZero]);
}

function Frame({ title, desc, children, yTicks, y, fmtAxis, first, last }: { title: string; desc: string; children: React.ReactNode; yTicks: number[]; y: (v: number) => number; fmtAxis: (v: number) => string; first?: string; last?: string }) {
  const id = useId();
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" role="img" aria-labelledby={`${id}-t ${id}-d`}>
      <title id={`${id}-t`}>{title}</title>
      <desc id={`${id}-d`}>{desc}</desc>
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={t === 0 ? 1.25 : 1} strokeDasharray={t === 0 ? undefined : "2 4"} />
          <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" className="num" fontSize="10.5" fill="var(--text-faint)">
            {fmtAxis(t)}
          </text>
        </g>
      ))}
      {first && (
        <text x={PAD.l} y={H - 6} className="num" fontSize="10.5" fill="var(--text-faint)">
          {first}
        </text>
      )}
      {last && (
        <text x={W - PAD.r} y={H - 6} textAnchor="end" className="num" fontSize="10.5" fill="var(--text-faint)">
          {last}
        </text>
      )}
      {children}
    </svg>
  );
}

function Tip({ x, y, label, value, up }: { x: number; y: number; label: string; value: string; up: boolean }) {
  const left = x > W * 0.62;
  return (
    <foreignObject x={left ? x - 170 : x + 10} y={Math.max(0, Math.min(y - 24, H - 52))} width="160" height="50" style={{ overflow: "visible", pointerEvents: "none" }}>
      <div className="rounded-[var(--radius-sm)] border border-line-strong bg-[color-mix(in_oklab,var(--surface-2)_94%,transparent)] px-2.5 py-1.5 shadow-[var(--shadow-float)]">
        <p className="num text-[10.5px] text-faint">{label}</p>
        <p className="num flex items-center gap-1 text-[12.5px] text-fg">
          {up ? <ArrowUpRight className="size-3 text-buy" aria-hidden /> : <ArrowDownRight className="size-3 text-sell" aria-hidden />}
          {value}
        </p>
      </div>
    </foreignObject>
  );
}

/** Rendimiento acumulado: una sola serie (sin leyenda; el título la nombra). */
export function CumulativeChart({ points, fmt, fmtAxis }: { points: Point[]; fmt: (v: number) => string; fmtAxis: (v: number) => string }) {
  const s = useScale(points);
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${s.y(p.v).toFixed(1)}`).join("");
  const area = n ? `${path}L${x(n - 1).toFixed(1)},${s.y(0).toFixed(1)}L${x(0).toFixed(1)},${s.y(0).toFixed(1)}Z` : "";
  const last = points[n - 1]?.v ?? 0;
  const tone = last >= 0 ? "var(--buy)" : "var(--sell)";
  const gid = useId();
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * (W - PAD.l - PAD.r);
    setHover(Math.max(0, Math.min(n - 1, Math.round((px / (W - PAD.l - PAD.r)) * (n - 1)))));
  };
  return (
    <Frame title="Rendimiento acumulado" desc={`Termina en ${fmt(last)}`} yTicks={s.ticks} y={s.y} fmtAxis={fmtAxis} first={points[0]?.label} last={points[n - 1]?.label}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={tone} stopOpacity="0.22" />
          <stop offset="1" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      {n > 0 && <path d={area} fill={`url(#${gid})`} />}
      {n > 0 && <path d={path} fill="none" stroke={tone} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
      {n > 0 && <circle cx={x(n - 1)} cy={s.y(last)} r={4} fill={tone} stroke="var(--surface-1)" strokeWidth={2} />}
      {hover !== null && points[hover] && (
        <g pointerEvents="none">
          <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--border-strong)" />
          <circle cx={x(hover)} cy={s.y(points[hover].v)} r={4.5} fill={tone} stroke="var(--surface-1)" strokeWidth={2} />
          <Tip x={x(hover)} y={s.y(points[hover].v)} label={points[hover].label} value={fmt(points[hover].v)} up={points[hover].v >= 0} />
        </g>
      )}
      <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
    </Frame>
  );
}

/** P&L por intervalo: barras con polaridad (verde ganancia, rojo pérdida) ancladas en el cero. */
export function DailyBars({ points, fmt, fmtAxis }: { points: Point[]; fmt: (v: number) => string; fmtAxis: (v: number) => string }) {
  const s = useScale(points);
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(1, points.length);
  const slot = (W - PAD.l - PAD.r) / n;
  const bw = Math.max(2, Math.min(28, slot - 2)); // 2 px de hueco entre barras
  const zero = s.y(0);
  return (
    <Frame title="P&L por intervalo" desc={`${points.length} intervalos`} yTicks={s.ticks} y={s.y} fmtAxis={fmtAxis} first={points[0]?.label} last={points[points.length - 1]?.label}>
      {points.map((p, i) => {
        const cx = PAD.l + slot * i + slot / 2;
        const yv = s.y(p.v);
        const h = Math.abs(yv - zero);
        const up = p.v >= 0;
        const r = Math.min(4, bw / 2, h);
        // extremo redondeado (4 px) lejos del cero; la base queda recta sobre la línea del cero
        const x0 = cx - bw / 2;
        const d = up
          ? `M${x0},${zero}V${yv + r}Q${x0},${yv} ${x0 + r},${yv}H${x0 + bw - r}Q${x0 + bw},${yv} ${x0 + bw},${yv + r}V${zero}Z`
          : `M${x0},${zero}V${yv - r}Q${x0},${yv} ${x0 + r},${yv}H${x0 + bw - r}Q${x0 + bw},${yv} ${x0 + bw},${yv - r}V${zero}Z`;
        return (
          <g key={p.t}>
            {h > 0.5 && <path d={d} fill={up ? "var(--buy)" : "var(--sell)"} opacity={hover === null || hover === i ? 0.9 : 0.45} />}
            <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={H - PAD.t - PAD.b} fill="transparent" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />
          </g>
        );
      })}
      {hover !== null && points[hover] && <Tip x={PAD.l + slot * hover + slot / 2} y={s.y(points[hover].v)} label={points[hover].label} value={fmt(points[hover].v)} up={points[hover].v >= 0} />}
    </Frame>
  );
}
