"use client";

// Lanzamiento en curso dentro del Live (al pulsar «Lanzar» el asistente abre /t/<mint>?launch=<id>):
// mientras el token no existe, «Creando $SYM…»; después, una tira con el estado y cada compra.
import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, PauseCircle, Play, Rocket, TriangleAlert, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { fmtMs } from "@/lib/draft";
import type { LaunchView } from "@/lib/launch-run";
import { LaunchBuys, buyState, useNow } from "@/components/launch/launch-buys";

const ACTIVE = ["PREPARED", "CREATING", "CREATED", "BUYING"];
const STATUS: Record<string, string> = { PREPARED: "Preparando", CREATING: "Creando el token", CREATED: "Token creado", BUYING: "Comprando", DONE: "Lanzado", FAILED: "Falló", PAUSED: "En pausa", CANCELLED: "Cancelado" };

/** Sondea el lanzamiento mientras está en marcha (cada 700 ms) y se detiene al terminar. */
export function useLaunchWatch(id: string | null) {
  const [view, setView] = useState<LaunchView | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      try {
        const v = await api<LaunchView>(`/launches/${encodeURIComponent(id)}`);
        if (!alive) return;
        setView(v);
        if (ACTIVE.includes(v.status)) t = setTimeout(loop, 700);
      } catch {
        if (alive) t = setTimeout(loop, 1500);
      }
    };
    void loop();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [id, nonce]);
  return { view, refresh: () => setNonce((n) => n + 1) };
}

async function resumeLaunch(id: string, refresh: () => void) {
  try {
    await api(`/launches/${encodeURIComponent(id)}/resume`, { method: "POST", body: {} });
    refresh();
  } catch (e) {
    toast({ tone: "error", title: "No se pudo reanudar", body: (e as ApiError).message });
  }
}

/** Pantalla mientras el token aún no existe en cadena (o si la creación falló). */
export function LaunchPending({ view, refresh }: { view: LaunchView | null; refresh: () => void }) {
  const failed = view?.status === "FAILED";
  const paused = view?.status === "PAUSED";
  return (
    <div className="grid h-[calc(100dvh-80px)] place-items-center p-6">
      <div className="panel reticle w-full max-w-[460px] p-6" role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          {failed ? <TriangleAlert className="size-5 text-sell" aria-hidden /> : paused ? <PauseCircle className="size-5 text-warn" aria-hidden /> : <Loader2 className="size-5 animate-spin text-accent-b" aria-hidden />}
          <h1 className="text-[16px] font-semibold">{failed ? "La creación falló" : paused ? "Lanzamiento en pausa" : `Creando ${view?.symbol ? `$${view.symbol}` : "el token"}…`}</h1>
        </div>
        <p className="mt-2 text-[13px] text-muted">
          {failed ? (view?.error ?? "No se creó ningún token.") : paused ? "Falta saber si la creación entró. Reanuda para comprobarlo en la cadena (nunca duplica)." : "Crear el token y el dev buy van en la misma transacción. El gráfico aparece aquí en cuanto se confirma."}
        </p>
        <div className="mt-5 flex gap-2">
          {paused && view && (
            <button onClick={() => resumeLaunch(view.id, refresh)} className="btn h-9 px-3 text-[13px]">
              <Play className="size-3.5" aria-hidden /> Reanudar
            </button>
          )}
          <Link href={failed && view ? `/launch/new?draft=${encodeURIComponent(view.id)}` : "/launches"} className="btn h-9 px-3 text-[13px]">
            {failed ? "Volver al asistente" : "Ver lanzamientos"}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Tira compacta sobre el Live con el estado del lanzamiento y sus compras; se despliega para ver detalles. */
export function LaunchStrip({ view, refresh, onClose }: { view: LaunchView; refresh: () => void; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const active = ACTIVE.includes(view.status);
  const now = useNow(active);
  const ok = view.buys.filter((b) => b.status === "OK").length;
  return (
    <section aria-label="Lanzamiento en curso" className="panel shrink-0 px-3 py-2">
      <div className="flex items-center gap-3 text-[12.5px]">
        {view.status === "DONE" ? <CheckCircle2 className="size-4 shrink-0 text-buy" aria-hidden /> : view.status === "PAUSED" ? <PauseCircle className="size-4 shrink-0 text-warn" aria-hidden /> : view.status === "FAILED" ? <TriangleAlert className="size-4 shrink-0 text-sell" aria-hidden /> : <Rocket className="size-4 shrink-0 animate-pulse text-accent-b" aria-hidden />}
        <span className="shrink-0 font-medium">
          ${view.symbol} · {STATUS[view.status] ?? view.status}
        </span>
        {view.mode !== "manual" && <span className="num shrink-0 text-muted">compras {ok}/{view.buys.length}</span>}
        <ul className="scroll-thin flex min-w-0 flex-1 gap-1.5 overflow-x-auto" aria-label="Compras">
          {view.buys.map((b) => {
            const st = buyState(b, now);
            return (
              <li key={b.ord} className="chip h-6 shrink-0 gap-1.5 px-2 text-[11px]" title={`${b.label}: ${st.text}`}>
                {st.icon}
                <span className="max-w-[90px] truncate">{b.label}</span>
                <span className={`num ${st.tone}`}>{b.status === "OK" && b.sentAfterMs != null ? `T+${fmtMs(b.sentAfterMs)}` : st.short}</span>
              </li>
            );
          })}
        </ul>
        {view.status === "PAUSED" && (
          <button onClick={() => resumeLaunch(view.id, refresh)} className="btn h-7 shrink-0 px-2.5 text-[12px]">
            <Play className="size-3.5" aria-hidden /> Reanudar
          </button>
        )}
        {view.mode !== "manual" && (
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="btn btn-ghost h-7 shrink-0 px-2 text-[12px]">
            {open ? "Ocultar" : "Detalles"}
          </button>
        )}
        {!active && (
          <button onClick={onClose} aria-label="Cerrar el aviso del lanzamiento" className="btn-ghost grid size-7 shrink-0 place-items-center rounded">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1 border-t border-line pt-1">
          <LaunchBuys view={view} max="max-h-40" />
        </div>
      )}
    </section>
  );
}
