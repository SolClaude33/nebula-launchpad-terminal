"use client";

import { LiveNumber } from "@/components/live-number";
import { usePosition, useSim } from "@/lib/sim";
import { fmtPct, fmtSol, fmtTokens } from "@/lib/format";

export function PositionCard() {
  const all = usePosition();
  const wallets = useSim((s) => s.wallets);
  const dev = usePosition(wallets.filter((w) => w.role === "dev").map((w) => w.id));
  const holders = usePosition(wallets.filter((w) => w.role === "holder").map((w) => w.id));
  const trading = usePosition(wallets.filter((w) => w.role === "trading").map((w) => w.id));
  const up = all.pnl >= 0;
  const split = [
    { k: "Dev", v: dev.supplyPct, c: "var(--warn)" },
    { k: "Holders", v: holders.supplyPct, c: "var(--accent)" },
    { k: "Trading", v: trading.supplyPct, c: "var(--accent-b)" },
  ];

  return (
    <section aria-label="Posición agregada" className="panel p-4">
      <div className="flex items-center justify-between">
        <p className="telemetry">03 · Posición agregada</p>
        <span className="num text-[11.5px] text-faint">{wallets.filter((w) => w.tokens > 0).length} wallets</span>
      </div>
      <div className="mt-3 flex items-end justify-between">
        <div>
          <p className="text-[12px] text-muted">Valor</p>
          <p className="text-[22px] leading-tight font-medium">
            <LiveNumber value={all.value} format={(v) => fmtSol(v)} />
          </p>
        </div>
        <div className="text-right">
          <p className="text-[12px] text-muted">P&L no realizado</p>
          <p className={`text-[15px] font-medium ${up ? "text-buy" : "text-sell"}`}>
            <LiveNumber value={all.pnl} format={(v) => `${v >= 0 ? "+" : "−"}${fmtSol(Math.abs(v))}`} />
            <span className="num ml-1.5 text-[12px]">({fmtPct(all.pnlPct, 1, true)})</span>
          </p>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted">Supply en wallets propias</span>
          <span className="num">{fmtPct(all.supplyPct)}</span>
        </div>
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={split.map((s) => `${s.k} ${fmtPct(s.v)}`).join(", ")}>
          {split.map((s) => (
            <div key={s.k} style={{ width: `${(s.v / Math.max(all.supplyPct, 0.0001)) * 100}%`, background: s.c }} className="h-full transition-[width] duration-500" />
          ))}
        </div>
        <ul className="mt-2.5 grid grid-cols-3 gap-2 text-[11.5px]">
          {split.map((s) => (
            <li key={s.k} className="flex items-center gap-1.5 text-muted">
              <span className="size-2 rounded-full" style={{ background: s.c }} />
              {s.k} <span className="num ml-auto text-fg">{fmtPct(s.v, 1)}</span>
            </li>
          ))}
        </ul>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-[12px]">
        <div>
          <dt className="text-muted">Tokens</dt>
          <dd className="num mt-0.5">{fmtTokens(all.tokens)}</dd>
        </div>
        <div>
          <dt className="text-muted">Coste base</dt>
          <dd className="num mt-0.5">{fmtSol(all.cost)}</dd>
        </div>
        <div>
          <dt className="text-muted">SOL disponible</dt>
          <dd className="num mt-0.5">{fmtSol(all.sol)}</dd>
        </div>
        <div>
          <dt className="text-muted">Automatizaciones</dt>
          <dd className="mt-0.5 flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-buy" /> 1 DCA activa
          </dd>
        </div>
      </dl>
    </section>
  );
}
