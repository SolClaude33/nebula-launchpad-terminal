"use client";

import { useEffect, useState } from "react";
import { Globe, Send, Star } from "lucide-react";
import { trackToken, untrackToken, useTracked } from "@/lib/tracker";
import { Address } from "@/components/address";
import { LiveNumber } from "@/components/live-number";
import { GraduationOrbit } from "./graduation-orbit";
import { fmtMoney, lamToSol, useLive } from "@/lib/live";
import { fmtNum, fmtSol, fmtUsd, timeAgo } from "@/lib/format";

export function TokenGlyph({ symbol, size = 52 }: { symbol: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-[14px] border border-line-strong"
      style={{ width: size, height: size, background: "radial-gradient(circle at 30% 25%, #c4b5fd, var(--accent-a) 45%, #0b1030 100%)" }}
    >
      <span className="absolute inset-[18%] rounded-full border border-white/25" />
      <span className="absolute size-[28%] translate-x-[38%] -translate-y-[30%] rounded-full bg-accent-b/80 blur-[1px]" />
      <span className="font-display relative text-[22px] text-white" style={{ fontSize: size * 0.42 }}>
        {(symbol[0] ?? "?").toUpperCase()}
      </span>
    </span>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.2h1.7L7.42 4.7H5.6l11.07 14.5Z" />
    </svg>
  );
}

const VENUE = {
  curve: { label: "Bonding curve", hint: "Destino: PumpSwap" },
  migrating: { label: "Curva completa", hint: "Migrando a PumpSwap" },
  pumpswap: { label: "PumpSwap", hint: "Graduado" },
} as const;

/** REQ-LIVE-006: seguir o dejar de seguir el token en el tracker. */
function TrackStar({ mint }: { mint: string }) {
  const items = useTracked((s) => s.items);
  const refresh = useTracked((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (items === null) void refresh();
  }, [items, refresh]);
  const on = !!items?.some((t) => t.mint === mint);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        if (on) await untrackToken(mint);
        else await trackToken(mint);
        setBusy(false);
      }}
      disabled={busy || items === null}
      aria-pressed={on}
      aria-label={on ? "Dejar de seguir en el tracker" : "Seguir en el tracker"}
      title={on ? "En tu tracker · pulsa para quitarlo" : "Seguir en el tracker"}
      className="btn btn-ghost grid size-7 shrink-0 place-items-center p-0"
    >
      <Star className={`size-4 ${on ? "fill-warn text-warn" : "text-muted"}`} aria-hidden />
    </button>
  );
}

export function TokenHeader({ mint }: { mint: string }) {
  const info = useLive((s) => s.info)!;
  const token = useLive((s) => s.token);
  const stats = useLive((s) => s.stats);
  const holders = useLive((s) => s.holders);
  const trades = useLive((s) => s.trades);
  const solUsd = useLive((s) => s.solUsd?.usd ?? null);
  const mc = Number(info.marketCapLamports);
  // Variación respecto al primer trade de la última hora indexada
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, 10_000);
    const first = setTimeout(tick, 0);
    return () => (clearInterval(id), clearTimeout(first));
  }, []);
  const hourAgo = now - 3600_000;
  const ref = trades.find((t) => t.ts >= hourAgo);
  const base = ref ? Number(ref.mc) : 0;
  const chg = base > 0 ? ((mc - base) / base) * 100 : null;
  const ath = trades.reduce((a, t) => Math.max(a, Number(t.mc)), mc);
  const name = token?.name ?? info.metadata?.name ?? "Token sin nombre";
  const symbol = token?.symbol ?? info.metadata?.symbol ?? "";
  const links = token?.links;
  const venue = VENUE[info.venue];

  const stats4 = [
    { k: "Precio", v: <LiveNumber value={info.priceLamports} format={(x) => `${(x / 1e3).toLocaleString("es-ES", { maximumFractionDigits: 3 })} µSOL`} />, wide: true },
    { k: "Volumen", v: <LiveNumber value={lamToSol(stats?.volumeLamports ?? 0)} format={(x) => fmtSol(x, 1)} />, wide: false },
    { k: holders && !holders.complete ? "Holders (top)" : "Holders", v: <span className="num">{holders ? fmtNum(holders.count) : "—"}</span>, wide: false },
    { k: "ATH indexado", v: <span className="num">{fmtMoney(ath, solUsd)}</span>, wide: true },
  ];

  return (
    <section aria-label="Resumen del token" className="panel reticle flex items-center gap-6 overflow-hidden px-5 py-4">
      <div className="flex min-w-0 items-center gap-4">
        <TokenGlyph symbol={symbol || name} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[19px] font-semibold tracking-[-0.01em]">{name}</h1>
            {symbol && <span className="num text-[13px] text-muted">${symbol}</span>}
            <TrackStar mint={mint} />
            <span className="chip hidden h-5 px-1.5 text-[10.5px] xl:inline-flex">{info.mayhem ? "Mayhem" : "Classic"}</span>
            {token?.feeMode && <span className="chip hidden h-5 px-1.5 text-[10.5px] xl:inline-flex">{token.feeMode === "holders" ? "Holder rewards" : "Creator fees"}</span>}
            {token?.own && <span className="chip hidden h-5 border-accent/30 px-1.5 text-[10.5px] text-accent xl:inline-flex">lanzado con Nébula</span>}
          </div>
          <div className="mt-1 flex items-center gap-3 text-[12px] whitespace-nowrap text-muted">
            <Address value={mint} kind="token" head={6} tail={4} />
            {token?.createdAt ? (
              <>
                <span className="hidden text-faint xl:inline">·</span>
                <span className="hidden xl:inline">creado hace {timeAgo(token.createdAt)}</span>
              </>
            ) : null}
            {links && (links.x || links.telegram || links.web) && (
              <>
                <span className="text-faint">·</span>
                <span className="flex items-center gap-1.5">
                  {links.x && (
                    <a href={links.x} target="_blank" rel="noreferrer" aria-label="X del token" className="hover:text-fg">
                      <XIcon className="size-3.5" />
                    </a>
                  )}
                  {links.telegram && (
                    <a href={links.telegram} target="_blank" rel="noreferrer" aria-label="Telegram del token" className="hover:text-fg">
                      <Send className="size-3.5" />
                    </a>
                  )}
                  {links.web && (
                    <a href={links.web} target="_blank" rel="noreferrer" aria-label="Web del token" className="hover:text-fg">
                      <Globe className="size-3.5" />
                    </a>
                  )}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-l border-line pl-6">
        <p className="telemetry">Market cap</p>
        <p className="mt-0.5 flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-[28px] leading-tight font-medium tracking-[-0.02em]">
            <LiveNumber value={mc} format={(x) => (solUsd ? fmtUsd(lamToSol(x) * solUsd, false).replace(/,\d+$/, "") : fmtSol(lamToSol(x), 2))} />
          </span>
          {chg !== null && (
            <span className={`num text-[12.5px] ${chg >= 0 ? "text-buy" : "text-sell"}`}>
              {chg >= 0 ? "+" : ""}
              {chg.toFixed(1).replace(".", ",")} % 1 h
            </span>
          )}
        </p>
        {solUsd && <p className="num text-[11.5px] text-faint">{fmtSol(lamToSol(mc), 2)}</p>}
      </div>

      <dl className="hidden min-w-0 flex-1 gap-6 overflow-hidden xl:flex">
        {stats4.map((s) => (
          <div key={s.k} className={`shrink-0 ${s.wide ? "hidden 2xl:block" : ""}`}>
            <dt className="telemetry text-[9.5px]">{s.k}</dt>
            <dd className="mt-1 text-[13.5px] whitespace-nowrap">{s.v}</dd>
          </div>
        ))}
      </dl>

      <div className="ml-auto flex shrink-0 items-center gap-3 xl:ml-0">
        <div className="hidden text-right xl:block">
          <p className="telemetry">{venue.label}</p>
          <p className="mt-1 text-[12px] whitespace-nowrap text-muted">{venue.hint}</p>
          <p className="text-[11px] whitespace-nowrap text-faint">fee del pad {(info.padFeeBps / 100).toLocaleString("es-ES")} %</p>
        </div>
        <GraduationOrbit pct={info.graduationPct} target={info.venue === "curve" ? `de ${fmtMoney(info.graduationMcLamports, solUsd)}` : info.venue === "pumpswap" ? "PumpSwap" : "migrando"} size={96} />
      </div>
    </section>
  );
}
