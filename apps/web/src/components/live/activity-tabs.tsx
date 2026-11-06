"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Star } from "lucide-react";
import { Address } from "@/components/address";
import { SUPPLY, priceSol, useSim, type Role } from "@/lib/sim";
import { fmtPct, fmtSol, fmtTokens, fmtUsd, timeAgo } from "@/lib/format";

type Tab = "trades" | "holders" | "wallets";

const ROLE_LABEL: Record<Role, string> = { dev: "Dev", holder: "Holder", trading: "Trading" };

export function ActivityTabs() {
  const [tab, setTab] = useState<Tab>("trades");
  const [onlyOwn, setOnlyOwn] = useState(false);
  const holdersCount = useSim((s) => Object.keys(s.holders).length);
  const walletsCount = useSim((s) => s.wallets.length);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "trades", label: "Trades en vivo" },
    { id: "holders", label: "Holders", count: holdersCount },
    { id: "wallets", label: "Mis wallets", count: walletsCount },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2">
        <div role="tablist" aria-label="Actividad del token" className="flex">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`relative flex h-11 items-center gap-2 px-3 text-[13px] whitespace-nowrap transition-colors ${tab === t.id ? "text-fg" : "text-muted hover:text-fg"}`}
            >
              {t.label}
              {t.count !== undefined && <span className="num rounded-full bg-surface-2 px-1.5 text-[10.5px] text-muted">{t.count}</span>}
              {tab === t.id && <span className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-gradient-to-r from-accent-a to-accent-b" />}
            </button>
          ))}
        </div>
        {tab === "trades" && (
          <label className="ml-auto flex cursor-pointer items-center gap-2 px-2 text-[12px] text-muted">
            <input type="checkbox" checked={onlyOwn} onChange={(e) => setOnlyOwn(e.target.checked)} className="size-3.5 accent-[var(--accent-a)]" />
            Solo las mías
          </label>
        )}
        {tab === "trades" && (
          <span className="telemetry flex items-center gap-1.5 pr-2">
            <span className="size-1.5 animate-pulse rounded-full bg-buy" /> en vivo
          </span>
        )}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {tab === "trades" && <TradesTable onlyOwn={onlyOwn} />}
        {tab === "holders" && <HoldersTable />}
        {tab === "wallets" && <WalletsTable />}
      </div>
    </div>
  );
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const th = "telemetry sticky top-0 z-10 bg-surface-1 px-3 py-2 text-left font-normal";
const td = "px-3 py-[7px] whitespace-nowrap";

function TradesTable({ onlyOwn }: { onlyOwn: boolean }) {
  const trades = useSim((s) => s.trades);
  const now = useNow();
  // Solo animan las filas que llegan después de abrir la tabla
  const [mountedAt] = useState(() => Date.now());
  const list = useMemo(() => (onlyOwn ? trades.filter((t) => t.own) : trades).slice(0, 60), [trades, onlyOwn]);

  if (list.length === 0)
    return <p className="p-8 text-center text-[13px] text-muted">Aún no hay operaciones de tus wallets en este token. Usa el ticket o el Instant Trade.</p>;

  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr>
          <th className={th}>Hace</th>
          <th className={th}>Lado</th>
          <th className={`${th} text-right`}>SOL</th>
          <th className={`${th} hidden text-right xl:table-cell`}>Tokens</th>
          <th className={`${th} text-right`}>Market cap</th>
          <th className={th}>Wallet</th>
          <th className={`${th} hidden xl:table-cell`}>Tx</th>
        </tr>
      </thead>
      <tbody>
        {list.map((t) => {
          const fresh = t.t > mountedAt;
          const buy = t.side === "buy";
          return (
            <tr key={t.id} className={`border-t border-line/60 ${fresh ? "row-in" : ""} ${t.own ? "bg-[color-mix(in_oklab,var(--accent-a)_6%,transparent)]" : ""} hover:bg-surface-2/60`}>
              <td className={`${td} num text-faint`}>{timeAgo(t.t, now)}</td>
              <td className={td}>
                <span className={`inline-flex items-center gap-1 font-medium ${buy ? "text-buy" : "text-sell"}`}>
                  {buy ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
                  {buy ? "Compra" : "Venta"}
                </span>
              </td>
              <td className={`${td} num text-right`}>{t.sol.toLocaleString("es-ES", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
              <td className={`${td} num hidden text-right text-muted xl:table-cell`}>{fmtTokens(t.tokens)}</td>
              <td className={`${td} num text-right text-muted`}>{fmtUsd(t.mc)}</td>
              <td className={td}>
                {t.own ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="chip h-5 border-accent/30 px-1.5 text-[10.5px] text-accent">propia</span>
                    <span className="text-fg">{t.label}</span>
                  </span>
                ) : (
                  <Address value={t.wallet} />
                )}
              </td>
              <td className={`${td} hidden xl:table-cell`}>
                <Address value={t.sig} kind="tx" head={3} tail={3} className="text-faint" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HoldersTable() {
  const holders = useSim((s) => s.holders);
  const wallets = useSim((s) => s.wallets);
  const own = useMemo(() => new Map(wallets.map((w) => [w.address, w])), [wallets]);
  const sum = Object.values(holders).reduce((a, b) => a + b, 0);
  const curve = Math.max(0, SUPPLY - sum);
  const rows = useMemo(
    () =>
      Object.entries(holders)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40),
    [holders],
  );
  const ownPct = wallets.reduce((a, w) => a + w.tokens, 0) / SUPPLY;

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-[12px] text-muted">
        <Star className="size-3.5 text-accent" aria-hidden />
        Tus wallets suman <span className="num text-fg">{fmtPct(ownPct * 100)}</span> de la supply.
      </div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr>
            <th className={th}>#</th>
            <th className={th}>Holder</th>
            <th className={`${th} text-right`}>Tokens</th>
            <th className={`${th} w-[38%]`}>% supply</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-line/60">
            <td className={`${td} num text-faint`}>—</td>
            <td className={td}>
              <span className="chip h-5 px-1.5 text-[10.5px]">Bonding curve</span>
            </td>
            <td className={`${td} num text-right text-muted`}>{fmtTokens(curve)}</td>
            <td className={td}>
              <Bar pct={(curve / SUPPLY) * 100} tone="curve" />
            </td>
          </tr>
          {rows.map(([a, tok], i) => {
            const w = own.get(a);
            return (
              <tr key={a} className={`border-t border-line/60 ${w ? "bg-[color-mix(in_oklab,var(--accent-a)_6%,transparent)]" : ""}`}>
                <td className={`${td} num text-faint`}>{i + 1}</td>
                <td className={td}>
                  {w ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="chip h-5 border-accent/30 px-1.5 text-[10.5px] text-accent">propia · {ROLE_LABEL[w.role]}</span>
                      <span>{w.label}</span>
                    </span>
                  ) : (
                    <Address value={a} />
                  )}
                </td>
                <td className={`${td} num text-right text-muted`}>{fmtTokens(tok)}</td>
                <td className={td}>
                  <Bar pct={(tok / SUPPLY) * 100} tone={w ? "own" : "ext"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function Bar({ pct, tone }: { pct: number; tone: "own" | "ext" | "curve" }) {
  const color = tone === "own" ? "var(--accent)" : tone === "curve" ? "var(--text-faint)" : "var(--accent-b)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, pct * (tone === "curve" ? 1 : 12))}%`, background: color, opacity: tone === "ext" ? 0.7 : 1 }} />
      </div>
      <span className="num w-14 text-right text-[11.5px] text-muted">{fmtPct(pct)}</span>
    </div>
  );
}

function WalletsTable() {
  const wallets = useSim((s) => s.wallets);
  const folders = useSim((s) => s.folders);
  const mc = useSim((s) => s.mc);
  const fname = (id: string) => folders.find((f) => f.id === id)?.name ?? "—";
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr>
          <th className={th}>Wallet</th>
          <th className={th}>Rol</th>
          <th className={th}>Carpeta</th>
          <th className={`${th} text-right`}>SOL</th>
          <th className={`${th} text-right`}>Tokens</th>
          <th className={`${th} text-right`}>Valor</th>
          <th className={`${th} text-right`}>P&L</th>
        </tr>
      </thead>
      <tbody>
        {wallets.map((w) => {
          const value = w.tokens * priceSol(mc);
          const pnl = value - w.costSol;
          return (
            <tr key={w.id} className="border-t border-line/60 hover:bg-surface-2/60">
              <td className={td}>
                <div className="flex flex-col">
                  <span>{w.label}</span>
                  <Address value={w.address} className="text-[11px] text-faint" />
                </div>
              </td>
              <td className={td}>
                <span className={`chip h-5 px-1.5 text-[10.5px] ${w.role === "dev" ? "border-warn/30 text-warn" : ""}`}>{ROLE_LABEL[w.role]}</span>
              </td>
              <td className={`${td} text-muted`}>{fname(w.folder)}</td>
              <td className={`${td} num text-right`}>{w.sol.toLocaleString("es-ES", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
              <td className={`${td} num text-right text-muted`}>{w.tokens > 0 ? fmtTokens(w.tokens) : "—"}</td>
              <td className={`${td} num text-right`}>{w.tokens > 0 ? fmtSol(value) : "—"}</td>
              <td className={`${td} num text-right ${w.tokens === 0 ? "text-faint" : pnl >= 0 ? "text-buy" : "text-sell"}`}>
                {w.tokens > 0 ? `${pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toLocaleString("es-ES", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}` : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
