"use client";

// «Mis wallets» del Live: cada wallet con su SOL, tokens, valor en SOL y P&L, y compra / venta en % con un clic.
// Las casillas forman la selección «Seleccionadas» que también usan el ticket y el Instant Trade.
// Todo sale de /live/:mint/position (sin llamadas nuevas al RPC); las órdenes van por runOrder (id idempotente).
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Address } from "@/components/address";
import { lamToSol, toTokens, useLive, type PosItem } from "@/lib/live";
import { runOrder } from "@/lib/trade";
import { useChain } from "@/lib/chain";
import { fmtPct, fmtTokens } from "@/lib/format";
import { num } from "@/lib/draft";

const SELL_PCTS = [25, 50, 100] as const;
const BUY_SLIP = 15;
const SELL_SLIP = 5;
const th = "telemetry sticky top-0 z-10 bg-surface-1 px-2.5 py-2 text-left font-normal";
const td = "px-2.5 py-[6px] whitespace-nowrap";
const sol = (lamports: number | string, digits = 3) => lamToSol(lamports).toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const roleOrder = (r: string | null) => (r === "dev" ? 0 : r ? 1 : 2);

export function WalletsPanel() {
  const position = useLive((s) => s.position);
  const decimals = useLive((s) => s.info?.decimals ?? 6);
  const blocked = useLive((s) => s.info?.venue === "migrating");
  const picked = useLive((s) => s.picked);
  const setPicked = useLive((s) => s.setPicked);
  const sendPerSec = useChain((s) => s.status?.sendPerSec ?? 0);
  const [amount, setAmount] = useState("0,05");
  const [busy, setBusy] = useState<Record<string, string>>({});
  if (!position) return <div className="skeleton m-3 h-24" aria-busy="true" />;
  if (position.items.length === 0) return <p className="p-8 text-center text-[13px] text-muted">No tienes wallets activas. Créalas en Wallets.</p>;

  const items = [...position.items].sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.label.localeCompare(b.label, "es"));
  const sel = new Set(picked);
  const chosen = items.filter((w) => sel.has(w.walletId));
  const lamports = Math.round(num(amount) * 1e9);
  const amountOk = Number.isFinite(lamports) && lamports > 0;
  const allOn = items.length > 0 && chosen.length === items.length;

  const run = async (key: string, ids: string[], action: { buy: true } | { pct: number }) => {
    if (ids.length === 0 || blocked) return;
    setBusy((b) => ({ ...b, ...Object.fromEntries(ids.map((id) => [id, key])) }));
    await runOrder("buy" in action ? { side: "buy", walletIds: ids, lamportsEach: String(lamports), slippagePct: BUY_SLIP } : { side: "sell", walletIds: ids, pct: action.pct, slippagePct: SELL_SLIP }, "instant");
    setBusy((b) => Object.fromEntries(Object.entries(b).filter(([id]) => !ids.includes(id))));
  };
  const holdingIds = (ws: PosItem[]) => ws.filter((w) => BigInt(w.tokens) > 0n).map((w) => w.walletId);
  const toggle = (id: string) => setPicked(sel.has(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  return (
    <div>
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-line bg-surface-1 px-2.5 py-2 text-[12px]">
        <label htmlFor="panel-amount" className="text-muted">
          Compra
        </label>
        <span className="relative">
          <input id="panel-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!amountOk} className="field num h-7 w-[84px] pr-9 text-right text-[12px]" />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10.5px] text-faint">SOL</span>
        </span>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <span className="text-muted">Marcadas ({chosen.length}):</span>
        <button onClick={() => run("buy", chosen.map((w) => w.walletId), { buy: true })} disabled={chosen.length === 0 || !amountOk || blocked} className="btn btn-buy h-7 px-2.5 text-[12px]">
          Comprar
        </button>
        {SELL_PCTS.map((p) => (
          <button key={p} onClick={() => run(`sell-${p}`, holdingIds(chosen), { pct: p })} disabled={holdingIds(chosen).length === 0 || blocked} className="btn btn-sell h-7 px-2 text-[12px]">
            {p} %
          </button>
        ))}
        {sendPerSec > 0 && chosen.length > 1 && (
          <span className="text-[11px] text-faint">
            salen de {sendPerSec} en {sendPerSec} por segundo
          </span>
        )}
      </div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr>
            <th className={`${th} w-8`}>
              <input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? [] : items.map((w) => w.walletId))} aria-label="Marcar todas las wallets" className="size-3.5 accent-[var(--accent-a)]" />
            </th>
            <th className={th}>Wallet</th>
            <th className={`${th} text-right`}>SOL</th>
            <th className={`${th} text-right`}>Tokens</th>
            <th className={`${th} text-right`} title="Lo que valen los tokens que quedan, en SOL, al precio actual">
              Valor
            </th>
            <th className={`${th} text-right`} title="Realizado (ventas) + no realizado (valor − coste de lo que queda)">
              P&L
            </th>
            <th className={`${th} text-right`}>Operar</th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => {
            const has = BigInt(w.tokens) > 0n;
            const pnl = w.realizedLamports + w.valueLamports - w.costLamports;
            const pct = w.costLamports > 0 ? (pnl / w.costLamports) * 100 : null;
            const traded = w.costLamports > 0 || w.realizedLamports !== 0;
            const doing = busy[w.walletId];
            return (
              <tr key={w.walletId} className={`border-t border-line/60 ${sel.has(w.walletId) ? "bg-[color-mix(in_oklab,var(--accent-b)_6%,transparent)]" : "hover:bg-surface-2/60"}`}>
                <td className={td}>
                  <input type="checkbox" checked={sel.has(w.walletId)} onChange={() => toggle(w.walletId)} aria-label={`Marcar ${w.label}`} className="size-3.5 accent-[var(--accent-a)]" />
                </td>
                <td className={td}>
                  <div className="flex items-center gap-1.5">
                    <span className="max-w-[140px] truncate font-medium">{w.label}</span>
                    {w.role && <span className={`chip h-4.5 px-1.5 text-[10px] ${w.role === "dev" ? "border-warn/30 text-warn" : ""}`}>{w.role}</span>}
                  </div>
                  <Address value={w.address} className="text-[11px] text-faint" />
                </td>
                <td className={`${td} num text-right`}>{sol(w.lamports)}</td>
                <td className={`${td} num text-right text-muted`}>{has ? fmtTokens(toTokens(w.tokens, decimals)) : "—"}</td>
                <td className={`${td} num text-right`}>{has ? sol(w.valueLamports, 4) : "—"}</td>
                <td className={`${td} num text-right ${!traded ? "text-faint" : pnl >= 0 ? "text-buy" : "text-sell"}`}>
                  {traded ? (
                    <>
                      {pnl >= 0 ? "+" : "−"}
                      {sol(Math.abs(pnl), 4)}
                      {pct !== null && <span className="ml-1 text-[11px]">({fmtPct(pct, 1, true)})</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={`${td} text-right`}>
                  <div className="inline-flex items-center gap-1">
                    {doing && <Loader2 className="size-3.5 animate-spin text-muted" aria-label="Orden en curso" />}
                    <button onClick={() => run("buy", [w.walletId], { buy: true })} disabled={!!doing || !amountOk || blocked} className="btn btn-buy h-7 px-2 text-[11.5px]" aria-label={`Comprar ${amount} SOL con ${w.label}`}>
                      Comprar
                    </button>
                    {SELL_PCTS.map((p) => (
                      <button key={p} onClick={() => run(`sell-${p}`, [w.walletId], { pct: p })} disabled={!!doing || !has || blocked} className="btn btn-sell h-7 px-1.5 text-[11.5px]" aria-label={`Vender el ${p} % de ${w.label}`}>
                        {p}%
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
