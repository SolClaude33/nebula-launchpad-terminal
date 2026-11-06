"use client";

import { useId } from "react";

/**
 * Progreso de la bonding curve dibujado como una órbita: el satélite avanza hacia PumpSwap.
 * `pct` sale de las reservas reales de la curva (tokens vendidos sobre los vendibles), no del market cap.
 */
export function GraduationOrbit({ pct, target, size = 168 }: { pct: number; target: string; size?: number }) {
  const id = useId();
  const p = Math.max(0, Math.min(1, pct / 100));
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 12;
  const start = 140; // grados
  const sweep = 260;
  const toXY = (deg: number, rad = r) => {
    const a = (deg * Math.PI) / 180;
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)] as const;
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = toXY(from);
    const [x2, y2] = toXY(to);
    const large = to - from > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };
  const endDeg = start + sweep * p;
  const [sx, sy] = toXY(endDeg);
  const ticks = Array.from({ length: 27 }, (_, i) => start + (sweep / 26) * i);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Progreso hacia la graduación: ${(p * 100).toFixed(1)} %`}>
        <defs>
          <linearGradient id={`${id}-g`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--accent-a)" />
            <stop offset="100%" stopColor="var(--accent-b)" />
          </linearGradient>
          <radialGradient id={`${id}-core`}>
            <stop offset="0%" stopColor="color-mix(in oklab, var(--accent-a) 22%, transparent)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={r - 18} fill={`url(#${id}-core)`} />
        {ticks.map((d, i) => {
          const [x1, y1] = toXY(d, r + 7);
          const [x2, y2] = toXY(d, r + (i % 13 === 0 ? 11 : 9));
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--border-strong)" strokeWidth={1} />;
        })}
        <path d={arc(start, start + sweep)} fill="none" stroke="var(--surface-3)" strokeWidth={6} strokeLinecap="round" />
        <path d={arc(start, Math.max(start + 0.5, endDeg))} fill="none" stroke={`url(#${id}-g)`} strokeWidth={6} strokeLinecap="round" style={{ transition: "d 600ms var(--ease)" }} />
        <circle cx={sx} cy={sy} r={9} fill="var(--accent-b)" opacity={0.16} />
        <circle cx={sx} cy={sy} r={4.5} fill="var(--bg)" stroke="var(--accent-b)" strokeWidth={2} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pt-1 text-center">
        <span className="num leading-none font-medium" style={{ fontSize: size * 0.17 }}>
          {(p * 100).toFixed(1).replace(".", ",")}
          <span className="text-muted" style={{ fontSize: size * 0.1 }}> %</span>
        </span>
        {size >= 140 && <span className="telemetry mt-1.5 text-[9.5px]">hacia graduar</span>}
        <span className="num mt-1 text-muted" style={{ fontSize: Math.max(9.5, size * 0.085) }}>
          {target}
        </span>
      </div>
    </div>
  );
}
