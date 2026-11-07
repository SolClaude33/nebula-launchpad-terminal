"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Star } from "lucide-react";
import { Address } from "@/components/address";
import { fmtMoney, lamToSol, toTokens, useLive } from "@/lib/live";
import { WalletsPanel } from "@/components/live/wallets-panel";
import { fmtPct, fmtTokens, timeAgo } from "@/lib/format";

type Tab = "trades" | "holders" | "wallets";

const roleLabel = (r: string | null) => (r ? r.charAt(0).toUpperCase() + r.slice(1) : "—");

export function ActivityTabs() {
  const [tab, setTab] = useState<Tab>("trades");
  const [onlyOwn, setOnlyOwn] = useState(false);
  const holders = useLive((s) => s.holders);
  const walletsCount = useLive((s) => s.position?.items.length ?? 0);
  const feed = useLive((s) => s.feed);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "trades", label: "Trades en vivo" },
    { id: "holders", label: "Holders", count: holders?.count },
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
          <span className="telemetry flex items-center gap-1.5 pr-2" title={feed?.error ? `Último error del indexer: ${feed.error}` : feed?.ws ? "WebSocket de logs del RPC + sondeo cada 2 s" : "Sondeo de firmas cada 2 s"}>
            <span className={`size-1.5 rounded-full ${feed?.error ? "bg-warn" : "animate-pulse bg-buy"}`} /> {feed?.error ? "reintentando" : feed?.ws ? "en vivo · ws" : "en vivo"}
          </span>
        )}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="scroll-thin min-h-0 flex-1 overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-b">
        {tab === "trades" && <TradesTable onlyOwn={onlyOwn} />}
        {tab === "holders" && <HoldersTable />}
        {tab === "wallets" && <WalletsPanel />}
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
  const trades = useLive((s) => s.trades);
  const decimals = useLive((s) => s.info?.decimals ?? 6);
  const solUsd = useLive((s) => s.solUsd?.usd ?? null);
  const now = useNow();
  // Solo animan las filas que llegan después de abrir la tabla
  const [mountedAt] = useState(() => Date.now());
  const list = useMemo(() => (onlyOwn ? trades.filter((t) => t.own) : trades).slice(-80).reverse(), [trades, onlyOwn]);

  if (list.length === 0)
    return <p className="p-8 text-center text-[13px] text-muted">{onlyOwn ? "Aún no hay operaciones de tus wallets en este token. Usa el ticket o el Instant Trade." : "Aún no hay trades indexados de este token."}</p>;

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
          const fresh = t.ts > mountedAt;
          const buy = t.side === "buy";
          return (
            <tr key={`${t.signature}-${t.seq}`} className={`border-t border-line/60 ${fresh ? "row-in" : ""} ${t.own ? "bg-[color-mix(in_oklab,var(--accent-a)_6%,transparent)]" : ""} hover:bg-surface-2/60`}>
              <td className={`${td} num text-faint`}>{timeAgo(t.ts, now)}</td>
              <td className={td}>
                <span className={`inline-flex items-center gap-1 font-medium ${buy ? "text-buy" : "text-sell"}`}>
                  {buy ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
                  {buy ? "Compra" : "Venta"}
                  {t.venue === "pumpswap" && <span className="chip ml-1 h-4 px-1 text-[9.5px]">PumpSwap</span>}
                </span>
              </td>
              <td className={`${td} num text-right`}>{lamToSol(t.lamports).toLocaleString("es-ES", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</td>
              <td className={`${td} num hidden text-right text-muted xl:table-cell`}>{fmtTokens(toTokens(t.tokens, decimals))}</td>
              <td className={`${td} num text-right text-muted`}>{fmtMoney(t.mc, solUsd)}</td>
              <td className={td}>
                {t.own ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="chip h-5 border-accent/30 px-1.5 text-[10.5px] text-accent">propia</span>
                    <span className="text-fg">{t.own.label}</span>
                  </span>
                ) : (
                  <Address value={t.user} />
                )}
              </td>
              <td className={`${td} hidden xl:table-cell`}>
                <Address value={t.signature} kind="tx" head={3} tail={3} className="text-faint" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HoldersTable() {
  const holders = useLive((s) => s.holders);
  const info = useLive((s) => s.info);
  const position = useLive((s) => s.position);
  if (!holders || !info) return <div className="skeleton m-3 h-24" aria-busy="true" />;
  const supply = Number(info.supply);
  const ownPct = position ? (Number(position.total.tokens) / supply) * 100 : 0;
  let rank = 0;

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-[12px] text-muted">
        <Star className="size-3.5 text-accent" aria-hidden />
        Tus wallets suman <span className="num text-fg">{fmtPct(ownPct)}</span> de la supply.
        {!holders.complete && <span className="ml-auto text-faint">El RPC solo da los 20 mayores; las tuyas se leen siempre.</span>}
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
          {holders.items.map((h) => {
            if (!h.system) rank++;
            const pct = (Number(h.amount) / supply) * 100;
            const tone = h.system ? "curve" : h.own ? "own" : "ext";
            return (
              <tr key={h.owner} className={`border-t border-line/60 ${h.own ? "bg-[color-mix(in_oklab,var(--accent-a)_6%,transparent)]" : ""}`}>
                <td className={`${td} num text-faint`}>{h.system ? "—" : rank}</td>
                <td className={td}>
                  {h.system ? (
                    <span className="chip h-5 px-1.5 text-[10.5px]">{h.system}</span>
                  ) : h.own ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="chip h-5 border-accent/30 px-1.5 text-[10.5px] text-accent">propia{h.own.role ? ` · ${roleLabel(h.own.role)}` : ""}</span>
                      <span>{h.own.label}</span>
                    </span>
                  ) : (
                    <Address value={h.owner} />
                  )}
                </td>
                <td className={`${td} num text-right text-muted`}>{fmtTokens(toTokens(h.amount, info.decimals))}</td>
                <td className={td}>
                  <Bar pct={pct} tone={tone} />
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
