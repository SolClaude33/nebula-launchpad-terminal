"use client";

import { Globe, Send } from "lucide-react";
import { Address } from "@/components/address";
import { LiveNumber } from "@/components/live-number";
import { GraduationOrbit } from "./graduation-orbit";
import { SOL_USD, SUPPLY, useSim } from "@/lib/sim";
import { fmtNum, fmtSol, fmtUsd } from "@/lib/format";

export const DEMO_TOKEN = { name: "Kepler", symbol: "KEPLER", description: "Token de demostración del prototipo F0." };

export function TokenGlyph({ symbol, size = 52 }: { symbol: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-[14px] border border-line-strong"
      style={{ width: size, height: size, background: "radial-gradient(circle at 30% 25%, #c4b5fd, var(--accent-a) 45%, #0b1030 100%)" }}
    >
      <span className="absolute inset-[18%] rounded-full border border-white/25" />
      <span className="absolute size-[28%] translate-x-[38%] -translate-y-[30%] rounded-full bg-accent-b/80 blur-[1px]" />
      <span className="font-display relative text-[22px] text-white italic" style={{ fontSize: size * 0.42 }}>
        {symbol[0]}
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

export function TokenHeader({ mint }: { mint: string }) {
  const mc = useSim((s) => s.mc);
  const ath = useSim((s) => s.athMc);
  const vol = useSim((s) => s.volumeSol);
  const holders = useSim((s) => Object.keys(s.holders).length);
  const candles = useSim((s) => s.candles);
  const first = candles.length > 720 ? candles[candles.length - 720].open : candles[0]?.open ?? mc;
  const chg = first ? ((mc - first) / first) * 100 : 0;

  const stats = [
    { k: "Precio", v: <LiveNumber value={mc / SUPPLY / SOL_USD} format={(x) => `${(x * 1e6).toLocaleString("es-ES", { maximumFractionDigits: 3 })} µSOL`} />, wide: true },
    { k: "Volumen", v: <LiveNumber value={vol} format={(x) => fmtSol(x, 1)} />, wide: false },
    { k: "Holders", v: <LiveNumber value={holders} format={(x) => fmtNum(Math.round(x))} />, wide: false },
    { k: "ATH", v: <span className="num">{fmtUsd(ath)}</span>, wide: true },
  ];

  return (
    <section aria-label="Resumen del token" className="panel reticle flex items-center gap-6 overflow-hidden px-5 py-4">
      <div className="flex min-w-0 items-center gap-4">
        <TokenGlyph symbol={DEMO_TOKEN.symbol} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[19px] font-semibold tracking-[-0.01em]">{DEMO_TOKEN.name}</h1>
            <span className="num text-[13px] text-muted">${DEMO_TOKEN.symbol}</span>
            <span className="chip hidden h-5 px-1.5 text-[10.5px] xl:inline-flex">Classic</span>
            <span className="chip hidden h-5 px-1.5 text-[10.5px] xl:inline-flex">Creator fees</span>
          </div>
          <div className="mt-1 flex items-center gap-3 text-[12px] whitespace-nowrap text-muted">
            <Address value={mint} kind="token" head={6} tail={4} />
            <span className="hidden text-faint xl:inline">·</span>
            <span className="hidden xl:inline">creado hace 2 h</span>
            <span className="text-faint">·</span>
            <span className="flex items-center gap-1.5">
              <a href="#" aria-label="X del token" className="hover:text-fg"><XIcon className="size-3.5" /></a>
              <a href="#" aria-label="Telegram del token" className="hover:text-fg"><Send className="size-3.5" /></a>
              <a href="#" aria-label="Web del token" className="hover:text-fg"><Globe className="size-3.5" /></a>
            </span>
          </div>
        </div>
      </div>

      <div className="shrink-0 border-l border-line pl-6">
        <p className="telemetry">Market cap</p>
        <p className="mt-0.5 flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-[28px] leading-tight font-medium tracking-[-0.02em]">
            <LiveNumber value={mc} format={(x) => fmtUsd(x, false).replace(/,\d+$/, "")} />
          </span>
          <span className={`num text-[12.5px] ${chg >= 0 ? "text-buy" : "text-sell"}`}>
            {chg >= 0 ? "+" : ""}
            {chg.toFixed(1).replace(".", ",")} % 1 h
          </span>
        </p>
      </div>

      <dl className="hidden min-w-0 flex-1 gap-6 overflow-hidden xl:flex">
        {stats.map((s) => (
          <div key={s.k} className={`shrink-0 ${s.wide ? "hidden 2xl:block" : ""}`}>
            <dt className="telemetry text-[9.5px]">{s.k}</dt>
            <dd className="mt-1 text-[13.5px] whitespace-nowrap">{s.v}</dd>
          </div>
        ))}
      </dl>

      <div className="ml-auto flex shrink-0 items-center gap-3 xl:ml-0">
        <div className="hidden text-right xl:block">
          <p className="telemetry">Bonding curve</p>
          <p className="mt-1 text-[12px] whitespace-nowrap text-muted">Destino: PumpSwap</p>
          <p className="text-[11px] whitespace-nowrap text-faint">umbral estimado (demo)</p>
        </div>
        <GraduationOrbit mc={mc} size={96} />
      </div>
    </section>
  );
}
