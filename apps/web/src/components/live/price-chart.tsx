"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { lamToSol, useLive, type Trade } from "@/lib/live";
import { fmtSol, fmtUsd } from "@/lib/format";

type Candle = { time: number; open: number; high: number; low: number; close: number };

const FRAMES = [
  { id: "5s", sec: 5 },
  { id: "15s", sec: 15 },
  { id: "1m", sec: 60 },
  { id: "5m", sec: 300 },
] as const;
type FrameId = (typeof FRAMES)[number]["id"];

/** Velas del market cap a partir de los trades indexados: cada vela abre donde cerró la anterior. */
function candlesOf(trades: Trade[], sec: number, toValue: (mcLamports: number) => number): Candle[] {
  const out: Candle[] = [];
  let prev: number | null = null;
  for (const t of trades) {
    const v = toValue(Number(t.mc));
    const time = Math.floor(t.ts / 1000 / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, v);
      last.low = Math.min(last.low, v);
      last.close = v;
    } else if (last && time < last.time) {
      // un trade rezagado de una vela anterior: se aplica a la última sin reordenar
      last.high = Math.max(last.high, v);
      last.low = Math.min(last.low, v);
    } else {
      const open = prev ?? v;
      out.push({ time, open, close: v, high: Math.max(open, v), low: Math.min(open, v) });
    }
    prev = v;
  }
  return out;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function PriceChart() {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [frame, setFrame] = useState<FrameId>("15s");
  const [hover, setHover] = useState<Candle | null>(null);
  const trades = useLive((s) => s.trades);
  const solUsd = useLive((s) => s.solUsd?.usd ?? null);
  const sec = FRAMES.find((f) => f.id === frame)!.sec;
  // En USD si hay precio de SOL; si no, en SOL
  const toValue = useMemo(() => (solUsd ? (mc: number) => lamToSol(mc) * solUsd : (mc: number) => lamToSol(mc)), [solUsd]);
  const fmtValue = useMemo(() => (solUsd ? (v: number) => fmtUsd(v) : (v: number) => fmtSol(v, 1)), [solUsd]);
  const data = useMemo(() => candlesOf(trades, sec, toValue), [trades, sec, toValue]);
  const ownTrades = useMemo(() => trades.filter((t) => t.own), [trades]);
  const fmtRef = useRef(fmtValue);
  useEffect(() => {
    fmtRef.current = fmtValue;
  }, [fmtValue]);
  const unit = useRef<string>("");
  const lastLen = useRef(0);
  const lastFrame = useRef<FrameId | null>(null);

  // Crear el gráfico una vez
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--text-faint"), fontFamily: css("--font-geist-mono") || "monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: css("--grid-line") }, horzLines: { color: css("--grid-line") } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 6, barSpacing: 8 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: css("--border-strong"), labelBackgroundColor: css("--surface-3") }, horzLine: { color: css("--border-strong"), labelBackgroundColor: css("--surface-3") } },
      localization: { priceFormatter: (p: number) => fmtRef.current(p), locale: "es-ES" },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: css("--buy"),
      downColor: css("--sell"),
      borderVisible: false,
      wickUpColor: css("--buy"),
      wickDownColor: css("--sell"),
      priceLineColor: css("--accent-b"),
      priceLineStyle: 2,
    });
    chart.current = c;
    series.current = s;
    lastFrame.current = null; // fuerza setData completo tras (re)montar
    lastLen.current = 0;
    markers.current = createSeriesMarkers(s, []);
    c.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(s) as { open: number; high: number; low: number; close: number; time: number } | undefined;
      setHover(d ? { time: d.time, open: d.open, high: d.high, low: d.low, close: d.close } : null);
    });

    // Re-tematizar cuando cambia data-theme
    const mo = new MutationObserver(() => {
      c.applyOptions({
        layout: { textColor: css("--text-faint") },
        grid: { vertLines: { color: css("--grid-line") }, horzLines: { color: css("--grid-line") } },
      });
      s.applyOptions({ upColor: css("--buy"), downColor: css("--sell"), wickUpColor: css("--buy"), wickDownColor: css("--sell") });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      mo.disconnect();
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  // Datos: setData al cambiar de marco, update incremental en vivo
  useEffect(() => {
    const s = series.current;
    if (!s || data.length === 0) return;
    const toBar = (c: Candle) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
    const u = solUsd ? "usd" : "sol";
    if (lastFrame.current !== frame || unit.current !== u || Math.abs(data.length - lastLen.current) > 1) {
      s.setData(data.map(toBar));
      if (lastFrame.current !== frame) chart.current?.timeScale().scrollToRealTime();
      lastFrame.current = frame;
      unit.current = u;
    } else {
      s.update(toBar(data[data.length - 1]));
    }
    lastLen.current = data.length;
  }, [data, frame, solUsd]);

  // Marcadores de operaciones propias
  useEffect(() => {
    // Agrupa por vela y lado: una orden multi-wallet es un solo marcador "C 0,35 ×7"
    const groups = new Map<string, { time: number; side: "buy" | "sell"; sol: number; n: number }>();
    for (const t of ownTrades) {
      const time = Math.floor(t.ts / 1000 / sec) * sec;
      const key = `${time}-${t.side}`;
      const g = groups.get(key) ?? { time, side: t.side, sol: 0, n: 0 };
      g.sol += lamToSol(t.lamports);
      g.n += 1;
      groups.set(key, g);
    }
    const m: SeriesMarker<Time>[] = [...groups.values()]
      .sort((a, b) => a.time - b.time)
      .map((g) => ({
        time: g.time as UTCTimestamp,
        position: g.side === "buy" ? "belowBar" : "aboveBar",
        shape: g.side === "buy" ? "arrowUp" : "arrowDown",
        color: css(g.side === "buy" ? "--buy" : "--sell"),
        text: `${g.side === "buy" ? "C" : "V"} ${g.sol.toLocaleString("es-ES", { maximumFractionDigits: 2 })}${g.n > 1 ? ` ×${g.n}` : ""}`,
        size: 1,
      }));
    markers.current?.setMarkers(m);
  }, [ownTrades, sec]);

  const shown = hover ?? data[data.length - 1];
  const chg = shown ? ((shown.close - shown.open) / shown.open) * 100 : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 px-4 pt-3 pb-2">
        <p className="telemetry whitespace-nowrap">01 · Market cap</p>
        {shown && (
          <div className="num hidden items-center gap-3 text-[11.5px] whitespace-nowrap text-muted xl:flex" aria-live="off">
            <span>A <span className="text-fg">{fmtValue(shown.open)}</span></span>
            <span>M <span className="text-fg">{fmtValue(shown.high)}</span></span>
            <span>m <span className="text-fg">{fmtValue(shown.low)}</span></span>
            <span>C <span className="text-fg">{fmtValue(shown.close)}</span></span>
            <span className={chg >= 0 ? "text-buy" : "text-sell"}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)} %</span>
          </div>
        )}
        <div role="radiogroup" aria-label="Marco temporal" className="ml-auto flex rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-0.5">
          {FRAMES.map((f) => (
            <button
              key={f.id}
              role="radio"
              aria-checked={frame === f.id}
              onClick={() => setFrame(f.id)}
              className={`num h-7 rounded-[6px] px-2.5 text-[11.5px] transition-colors ${frame === f.id ? "bg-surface-3 text-fg shadow-sm" : "text-muted hover:text-fg"}`}
            >
              {f.id}
            </button>
          ))}
        </div>
      </div>
      <div ref={el} className="relative min-h-0 flex-1" aria-label="Gráfico de velas del market cap en vivo" role="img">
        {data.length === 0 && <p className="absolute inset-0 grid place-items-center text-[13px] text-muted">Aún no hay trades indexados de este token.</p>}
      </div>
    </div>
  );
}
