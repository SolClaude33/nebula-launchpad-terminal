"use client";

import { LiveNumber } from "@/components/live-number";
import { lamToSol, toTokens, useLive } from "@/lib/live";
import { fmtPct, fmtSol, fmtTokens } from "@/lib/format";

const COLORS = ["var(--warn)", "var(--accent)", "var(--accent-b)", "var(--buy)", "var(--text-faint)"];

export function PositionCard() {
  const position = useLive((s) => s.position);
  const info = useLive((s) => s.info);
  if (!position || !info) return <div className="skeleton h-[260px]" aria-busy="true" aria-label="Cargando posición" />;
  const supply = Number(info.supply);
  const t = position.total;
  const pnl = t.valueLamports - t.costLamports;
  const pnlPct = t.costLamports > 0 ? (pnl / t.costLamports) * 100 : 0;
  const up = pnl >= 0;
  const supplyPct = (Number(t.tokens) / supply) * 100;
  // Reparto por rol (los roles son libres: dev, holder, trading u otros)
  const byRole = new Map<string, number>();
  for (const i of position.items) if (BigInt(i.tokens) > 0n) byRole.set(i.role ?? "sin rol", (byRole.get(i.role ?? "sin rol") ?? 0) + Number(i.tokens));
  const split = [...byRole].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v], i) => ({ k: k.charAt(0).toUpperCase() + k.slice(1), v: (v / supply) * 100, c: COLORS[i] }));
  const holding = position.items.filter((i) => BigInt(i.tokens) > 0n).length;

  return (
    <section aria-label="Posición agregada" className="panel p-4">
      <div className="flex items-center justify-between">
        <p className="telemetry">03 · Posición agregada</p>
        <span className="num text-[11.5px] text-faint">{holding} wallets</span>
      </div>
      <div className="mt-3 flex items-end justify-between">
        <div>
          <p className="text-[12px] text-muted">Valor</p>
          <p className="text-[22px] leading-tight font-medium">
            <LiveNumber value={lamToSol(t.valueLamports)} format={(v) => fmtSol(v, Math.abs(v) >= 100 ? 1 : 3)} />
          </p>
        </div>
        <div className="text-right">
          <p className="text-[12px] text-muted">P&L no realizado</p>
          <p className={`text-[15px] font-medium ${up ? "text-buy" : "text-sell"}`}>
            <LiveNumber value={lamToSol(pnl)} format={(v) => `${v >= 0 ? "+" : "−"}${fmtSol(Math.abs(v), Math.abs(v) >= 100 ? 1 : 3)}`} />
            {t.costLamports > 0 && <span className="num ml-1.5 text-[12px]">({fmtPct(pnlPct, 1, true)})</span>}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted">Supply en wallets propias</span>
          <span className="num">{fmtPct(supplyPct)}</span>
        </div>
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={split.map((s) => `${s.k} ${fmtPct(s.v)}`).join(", ") || "Sin tokens"}>
          {split.map((s) => (
            <div key={s.k} style={{ width: `${(s.v / Math.max(supplyPct, 0.0001)) * 100}%`, background: s.c }} className="h-full transition-[width] duration-500" />
          ))}
        </div>
        {split.length > 0 && (
          <ul className="mt-2.5 grid grid-cols-3 gap-2 text-[11.5px]">
            {split.map((s) => (
              <li key={s.k} className="flex items-center gap-1.5 text-muted">
                <span className="size-2 shrink-0 rounded-full" style={{ background: s.c }} />
                <span className="truncate">{s.k}</span> <span className="num ml-auto text-fg">{fmtPct(s.v, 1)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-[12px]">
        <div>
          <dt className="text-muted">Tokens</dt>
          <dd className="num mt-0.5">{fmtTokens(toTokens(t.tokens, info.decimals))}</dd>
        </div>
        <div>
          <dt className="text-muted" title="Coste medio de los trades indexados de tus wallets, fees del pad incluidas">Coste base</dt>
          <dd className="num mt-0.5">{fmtSol(lamToSol(t.costLamports))}</dd>
        </div>
        <div>
          <dt className="text-muted">SOL disponible</dt>
          <dd className="num mt-0.5">{fmtSol(lamToSol(t.lamports))}</dd>
        </div>
        <div>
          <dt className="text-muted">P&L realizado</dt>
          <dd className={`num mt-0.5 ${t.realizedLamports >= 0 ? "text-buy" : "text-sell"}`}>
            {t.realizedLamports >= 0 ? "+" : "−"}
            {fmtSol(Math.abs(lamToSol(t.realizedLamports)))}
          </dd>
        </div>
      </dl>
    </section>
  );
}
