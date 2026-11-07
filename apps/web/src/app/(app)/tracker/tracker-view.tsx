"use client";

// REQ-LIVE-006: lista de seguimiento de tokens. Market cap (USD con Pyth) y graduación leídos por la API con
// caché de 20 s; no se indexan los trades de cada token (eso lo hace el Live al abrirlo).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Plus, Radar, Star, TriangleAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Address } from "@/components/address";
import { trackToken, untrackToken, type Tracked } from "@/lib/tracker";
import { fmtSol, fmtUsd, timeAgo } from "@/lib/format";

const VENUE: Record<string, string> = { curve: "Curva", migrating: "Graduando", pumpswap: "PumpSwap" };

export function TrackerView() {
  const [items, setItems] = useState<Tracked[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mint, setMint] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Tracked[] }>("/tracker")).items);
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial desde la API local
    void load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

  const add = async () => {
    const m = mint.trim();
    if (!m) return;
    setAdding(true);
    if (await trackToken(m)) {
      setMint("");
      await load();
    }
    setAdding(false);
  };

  return (
    <div className="mx-auto max-w-[1080px] p-6 pb-16">
      <p className="telemetry">Sistema</p>
      <h1 className="font-display mt-1 text-[30px] tracking-[-0.01em]">Tracker</h1>
      <p className="mt-1 max-w-[640px] text-[13px] text-muted">Tokens que sigues. Se actualizan cada 20 s; ábrelos en Live para ver sus trades en tiempo real. También puedes seguir un token con la estrella de su Live.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        className="mt-5 flex gap-2"
      >
        <label htmlFor="tracker-mint" className="sr-only">
          Dirección del token
        </label>
        <input id="tracker-mint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Pega la dirección (mint) de un token de Pump.fun" className="field num h-10 max-w-[520px] text-[13px]" />
        <button type="submit" disabled={!mint.trim() || adding} className="btn h-10 px-4 text-[13px]">
          {adding ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />} Seguir
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-4 flex items-center gap-2 text-[12.5px] text-warn">
          <TriangleAlert className="size-4" aria-hidden /> {error}
        </p>
      )}

      <div className="panel mt-5 overflow-hidden">
        {items === null ? (
          <div className="skeleton m-3 h-24" aria-busy="true" aria-label="Cargando el tracker" />
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Radar className="size-6 text-accent-b" aria-hidden />
            <p className="text-[14px] font-medium">Aún no sigues ningún token</p>
            <p className="max-w-[420px] text-[12.5px] text-muted">Pega un mint arriba o pulsa la estrella en el Live de un token.</p>
          </div>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left">
                {["Token", "Market cap", "Graduación", "Dónde", "Añadido", ""].map((h, i) => (
                  <th key={i} className={`telemetry px-4 py-2.5 font-normal ${i === 1 || i === 2 ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.mint} className="border-t border-line/60 hover:bg-surface-2/50">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{t.symbol ? `$${t.symbol}` : "—"}</span>
                      <span className="max-w-[220px] truncate text-muted">{t.name ?? ""}</span>
                      {t.own && <span className="chip h-4.5 border-accent/30 px-1.5 text-[10px] text-accent">propio</span>}
                    </div>
                    <Address value={t.mint} kind="token" className="text-[11px] text-faint" />
                  </td>
                  <td className="num px-4 py-2.5 text-right">{t.error ? <span className="text-warn" title={t.error}>sin datos</span> : t.mcUsd !== null ? fmtUsd(t.mcUsd) : t.marketCapLamports ? fmtSol(Number(t.marketCapLamports) / 1e9, 1) : "—"}</td>
                  <td className="px-4 py-2.5 text-right">
                    {t.graduationPct !== null ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                          <span className="block h-full rounded-full bg-gradient-to-r from-accent-a to-accent-b" style={{ width: `${Math.min(100, t.graduationPct)}%` }} />
                        </span>
                        <span className="num">{t.graduationPct.toLocaleString("es-ES", { maximumFractionDigits: 1 })} %</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2.5">{t.venue ? <span className="chip h-5 px-1.5 text-[10.5px]">{VENUE[t.venue] ?? t.venue}</span> : "—"}</td>
                  <td className="px-4 py-2.5 text-muted">hace {timeAgo(t.addedAt)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="inline-flex gap-1">
                      <Link href={`/t/${t.mint}`} className="btn h-8 px-2.5 text-[12px]">
                        Live <ArrowUpRight className="size-3.5" aria-hidden />
                      </Link>
                      <button
                        onClick={async () => {
                          await untrackToken(t.mint);
                          await load();
                        }}
                        aria-label={`Dejar de seguir ${t.symbol ?? t.mint}`}
                        title="Dejar de seguir"
                        className="btn btn-ghost grid size-8 place-items-center p-0"
                      >
                        <Star className="size-4 fill-warn text-warn" aria-hidden />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
