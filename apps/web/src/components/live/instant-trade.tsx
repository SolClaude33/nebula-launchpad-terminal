"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripHorizontal, Minus, SlidersHorizontal, Zap } from "lucide-react";
import { lamToSol, toTokens, useLive } from "@/lib/live";
import { runOrder, useWalletPicker } from "@/lib/trade";
import { fmtSol, fmtTokens } from "@/lib/format";
import { LiveNumber } from "@/components/live-number";
import { useJitoTip } from "@/lib/chain";

type Layout = "qwerty" | "azerty" | "qwertz";
const KEYS: Record<Layout, { buy: string[]; sell: string[] }> = {
  qwerty: { buy: ["Q", "W", "E", "R"], sell: ["A", "S", "D", "F"] },
  azerty: { buy: ["A", "Z", "E", "R"], sell: ["Q", "S", "D", "F"] },
  qwertz: { buy: ["Q", "W", "E", "R"], sell: ["A", "S", "D", "F"] },
};
const BUY_AMOUNTS = [0.05, 0.1, 0.25, 0.5];
const SELL_PCTS = [25, 50, 75, 100];
const STORE = "nebula.instant";

type Prefs = { x: number; y: number; opacity: number; blur: number; layout: Layout; min: boolean };
const DEFAULTS: Prefs = { x: -1, y: -1, opacity: 0.82, blur: 18, layout: "qwerty", min: false };

export function InstantTrade() {
  const ref = useRef<HTMLDivElement>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [armed, setArmed] = useState(false);
  const [settings, setSettings] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const { folders, scope, setScope, selected, pickedCount } = useWalletPicker("nebula.instant.scope");
  const position = useLive((s) => s.position);
  const info = useLive((s) => s.info);
  const ready = !!info && !!position;
  // P&L en vivo de la selección: valor actual menos coste base de los trades propios indexados
  const ids = new Set(selected.map((w) => w.id));
  const rows = (position?.items ?? []).filter((p) => ids.has(p.walletId));
  const pos = { tokens: rows.reduce((a, p) => a + Number(p.tokens), 0), pnl: lamToSol(rows.reduce((a, p) => a + p.valueLamports - p.costLamports, 0)) };
  const blocked = info?.venue === "migrating";
  const tip = useJitoTip();

  // Cargar preferencias guardadas en local
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- preferencia local leída tras montar para no romper la hidratación
      if (raw) setPrefs({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {}
  }, []);
  const save = useCallback((p: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...p };
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const clamp = useCallback((x: number, y: number) => {
    const el = ref.current;
    const w = el?.offsetWidth ?? 300;
    const h = el?.offsetHeight ?? 300;
    return { x: Math.max(8, Math.min(window.innerWidth - w - 8, x)), y: Math.max(8, Math.min(window.innerHeight - h - 8, y)) };
  }, []);

  // Posición inicial y re-encaje al cambiar el tamaño de ventana
  useEffect(() => {
    const fit = () => {
      setPrefs((p) => {
        // Por defecto: esquina inferior derecha de la zona del gráfico, sin tapar el ticket.
        const rightCol = window.innerWidth >= 1280 ? 340 : 300;
        const base = p.x < 0 ? { x: window.innerWidth - rightCol - 12 - 12 - 320 - 16, y: window.innerHeight - 470 } : { x: p.x, y: p.y };
        return { ...p, ...clamp(base.x, base.y) };
      });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [clamp, prefs.min]);

  // Arrastrar desde la barra
  const onDragStart = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,select,input")) return;
    const sx = e.clientX - prefs.x;
    const sy = e.clientY - prefs.y;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setPrefs((p) => ({ ...p, ...clamp(ev.clientX - sx, ev.clientY - sy) }));
    const up = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      save(clamp(ev.clientX - sx, ev.clientY - sy));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const fire = useCallback(
    async (kind: "buy" | "sell", i: number) => {
      const key = `${kind}-${i}`;
      if (pending) return;
      if (blocked) return;
      const ids = (kind === "buy" ? selected : selected.filter((w) => w.tokens > 0n)).map((w) => w.id);
      if (ids.length === 0) return;
      setPending(key);
      await runOrder(
        kind === "buy" ? { side: "buy", walletIds: ids, lamportsEach: String(Math.round(BUY_AMOUNTS[i] * 1e9)), slippagePct: 15 } : { side: "sell", walletIds: ids, pct: SELL_PCTS[i], slippagePct: 5 },
        "instant",
      );
      setPending(null);
    },
    [pending, selected, blocked],
  );

  // Atajos: mantener Espacio arma el teclado (REQ-LIVE-004)
  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.closest("input,textarea,select,[contenteditable=true]") !== null);
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) setArmed(true);
        return;
      }
      if (!armed || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toUpperCase();
      const map = KEYS[prefs.layout];
      const b = map.buy.indexOf(k);
      const s = map.sell.indexOf(k);
      if (b >= 0) {
        e.preventDefault();
        fire("buy", b);
      } else if (s >= 0) {
        e.preventDefault();
        fire("sell", s);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setArmed(false);
    };
    const blur = () => setArmed(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [armed, fire, prefs.layout]);

  if (!ready || prefs.x < 0) return null;
  const keys = KEYS[prefs.layout];

  return (
    <div
      ref={ref}
      role="region"
      aria-label="Instant Trade"
      className={`glass fixed z-[60] w-[320px] rounded-[var(--radius-lg)] shadow-[var(--shadow-float)] transition-[box-shadow,border-color] duration-200 ${armed ? "border-accent-b/60 shadow-[0_0_0_1px_var(--accent-b),0_0_40px_-6px_color-mix(in_oklab,var(--accent-b)_55%,transparent),var(--shadow-float)]" : ""}`}
      style={{ left: prefs.x, top: prefs.y, backdropFilter: `blur(${prefs.blur}px) saturate(140%)`, WebkitBackdropFilter: `blur(${prefs.blur}px) saturate(140%)`, background:`color-mix(in oklab, var(--surface-1) ${Math.round(prefs.opacity * 100)}%, transparent)` }}
    >
      <div onPointerDown={onDragStart} className="flex cursor-grab touch-none items-center gap-2 border-b border-line px-3 py-2 select-none active:cursor-grabbing">
        <GripHorizontal className="size-4 text-faint" aria-hidden />
        <Zap className={`size-3.5 ${armed ? "text-accent-b" : "text-accent"}`} aria-hidden />
        <span className="text-[13px] font-medium whitespace-nowrap">Instant Trade</span>
        <span aria-live="polite" className={`telemetry ml-1 rounded px-1.5 py-0.5 text-[9.5px] whitespace-nowrap ${armed ? "bg-accent-b/15 text-accent-b" : "bg-surface-2"}`}>
          {armed ? "armado" : "seguro"}
        </span>
        <div className="ml-auto flex items-center">
          <button onClick={() => setSettings((s) => !s)} aria-expanded={settings} aria-label="Ajustes del panel" className="btn-ghost grid size-7 place-items-center rounded-md">
            <SlidersHorizontal className="size-3.5" />
          </button>
          <button onClick={() => save({ min: !prefs.min })} aria-label={prefs.min ? "Expandir panel" : "Minimizar panel"} className="btn-ghost grid size-7 place-items-center rounded-md">
            <Minus className="size-3.5" />
          </button>
        </div>
      </div>

      {!prefs.min && (
        <div className="p-3">
          {settings && (
            <div className="mb-3 space-y-2.5 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-3 text-[12px]">
              <label className="flex items-center justify-between gap-3">
                <span className="text-muted">Opacidad</span>
                <input type="range" min={0.4} max={1} step={0.02} value={prefs.opacity} onChange={(e) => save({ opacity: Number(e.target.value) })} className="w-32 accent-[var(--accent-a)]" />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-muted">Desenfoque</span>
                <input type="range" min={0} max={32} step={1} value={prefs.blur} onChange={(e) => save({ blur: Number(e.target.value) })} className="w-32 accent-[var(--accent-a)]" />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-muted">Teclado</span>
                <select value={prefs.layout} onChange={(e) => save({ layout: e.target.value as Layout })} className="field h-7 w-32 py-0 text-[12px]">
                  <option value="qwerty">QWERTY</option>
                  <option value="azerty">AZERTY</option>
                  <option value="qwertz">QWERTZ</option>
                </select>
              </label>
            </div>
          )}

          <div className="flex items-center gap-2">
            <select aria-label="Carpeta del Instant Trade" value={scope} onChange={(e) => setScope(e.target.value)} className="field h-8 py-0 text-[12.5px]">
              <option value="all">Todas</option>
              <option value="picked">Marcadas ({pickedCount})</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <span className="chip num h-8 shrink-0 rounded-[var(--radius-sm)]">{selected.length} w.</span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 rounded-[var(--radius-sm)] border border-line bg-surface-2/40 px-3 py-2">
            <div>
              <p className="telemetry text-[9.5px]">Posición</p>
              <p className="num text-[13px]">{fmtTokens(toTokens(pos.tokens, info?.decimals ?? 6))}</p>
            </div>
            <div className="text-right">
              <p className="telemetry text-[9.5px]">P&L en vivo</p>
              <p className={`text-[13px] ${pos.pnl >= 0 ? "text-buy" : "text-sell"}`}>
                <LiveNumber value={pos.pnl} format={(v) => `${v >= 0 ? "+" : "−"}${fmtSol(Math.abs(v))}`} />
              </p>
            </div>
          </div>

          <p className="mt-3 mb-1.5 flex items-center justify-between text-[11.5px] text-muted">
            Comprar <span className="text-faint">SOL por wallet</span>
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {BUY_AMOUNTS.map((a, i) => (
              <button key={a} onClick={() => fire("buy", i)} disabled={!!pending || blocked || selected.length === 0} aria-keyshortcuts={`Space+${keys.buy[i]}`} className={`btn btn-buy h-[52px] flex-col gap-1 px-0 ${pending === `buy-${i}` ? "animate-pulse" : ""}`}>
                <span className="num text-[13px] leading-none">{a.toLocaleString("es-ES")}</span>
                <span className={`kbd h-4 min-w-4 text-[9px] ${armed ? "border-accent-b/60 text-accent-b" : ""}`}>{keys.buy[i]}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 mb-1.5 flex items-center justify-between text-[11.5px] text-muted">
            Vender <span className="text-faint">% de la posición</span>
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {SELL_PCTS.map((p, i) => (
              <button key={p} onClick={() => fire("sell", i)} disabled={!!pending || blocked || pos.tokens === 0} aria-keyshortcuts={`Space+${keys.sell[i]}`} className={`btn btn-sell h-[52px] flex-col gap-1 px-0 ${pending === `sell-${i}` ? "animate-pulse" : ""}`}>
                <span className="num text-[13px] leading-none">{p} %</span>
                <span className={`kbd h-4 min-w-4 text-[9px] ${armed ? "border-accent-b/60 text-accent-b" : ""}`}>{keys.sell[i]}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-center text-[11px] text-faint">
            {blocked ? "Migrando a PumpSwap: se podrá operar cuando exista el pool." : (
              <>
                Mantén <span className="kbd">Espacio</span> y pulsa la tecla. Sin Espacio, ninguna tecla opera.
              </>
            )}
          </p>
          {tip > 0n && <p className="mt-1 text-center text-[11px] text-faint">Cada compra y venta lleva una propina de Jito de <span className="num">{fmtSol(lamToSol(tip), 6)}</span> por wallet, además de las fees de red.</p>}
        </div>
      )}
    </div>
  );
}
