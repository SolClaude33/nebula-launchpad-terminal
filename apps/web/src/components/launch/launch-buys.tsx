"use client";

// Progreso de las compras de un lanzamiento (Quick/Pro): estado real de cada una y sus tiempos en ms desde la
// creación. Una compra enviada que aún no se confirma lo dice con su cuenta de segundos (no parece «en pausa»).
import { useEffect, useState } from "react";
import { CheckCircle2, CircleSlash, Clock, Loader2, Send, XCircle } from "lucide-react";
import { fmtMs } from "@/lib/draft";
import { fmtLamports } from "@/lib/chain";
import type { LaunchView } from "@/lib/launch-run";

type Buy = LaunchView["buys"][number];

export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Estado legible de una compra; `short` para chips. */
export function buyState(b: Buy, now: number) {
  if (b.status === "OK") return { icon: <CheckCircle2 className="size-3.5 shrink-0 text-buy" aria-hidden />, text: "entró", short: "entró", tone: "text-buy" };
  if (b.status === "FAILED") return { icon: <XCircle className="size-3.5 shrink-0 text-sell" aria-hidden />, text: "falló", short: "falló", tone: "text-sell" };
  if (b.status === "SKIPPED") return { icon: <CircleSlash className="size-3.5 shrink-0 text-faint" aria-hidden />, text: "omitida", short: "omitida", tone: "text-faint" };
  if (b.sentAt) {
    const s = Math.max(0, Math.round((now - b.sentAt) / 1000));
    return { icon: <Send className="size-3.5 shrink-0 animate-pulse text-accent-b" aria-hidden />, text: `enviada · esperando confirmación · ${s} s`, short: `confirmando ${s} s`, tone: "text-accent-b" };
  }
  return { icon: <Clock className="size-3.5 shrink-0 text-muted" aria-hidden />, text: "en cola", short: "en cola", tone: "text-muted" };
}

export function LaunchBuys({ view, max = "max-h-48" }: { view: Pick<LaunchView, "mode" | "buys" | "bundleResult">; max?: string }) {
  const live = view.buys.some((b) => b.status === "PENDING");
  const now = useNow(live);
  const ok = view.buys.filter((b) => b.status === "OK").length;
  return (
    <>
      <p className="mt-3 mb-1.5 flex items-center gap-1.5 text-[12px] text-muted">
        {live && <Loader2 className="size-3 animate-spin" aria-hidden />} Compras · {ok}/{view.buys.length}
      </p>
      {view.bundleResult?.transport === "simulated" && <p className="mb-1.5 text-[11.5px] text-warn">Bundle simulado en local. No se llamó al Block Engine y no hay bundle_id.</p>}
      {view.bundleResult?.transport === "block-engine" && <p className="num mb-1.5 text-[11.5px] text-faint">{view.bundleResult.bundleId ? `Bundle ${view.bundleResult.bundleId}` : "Bundle enviado al Block Engine"} · {view.bundleResult.status}{view.bundleResult.message ? ` · ${view.bundleResult.message}` : ""}</p>}
      <ul className={`scroll-thin ${max} space-y-1.5 overflow-y-auto`}>
        {view.buys.map((b) => {
          const st = buyState(b, now);
          return (
            <li key={b.ord} className="text-[12px]">
              <div className="flex items-center gap-2">
                {st.icon}
                <span className="min-w-0 flex-1 truncate">{b.label}</span>
                <span className="num text-muted">{fmtLamports(BigInt(b.lamports), 3)}</span>
              </div>
              <div className="num mt-0.5 flex flex-wrap gap-x-2 pl-5.5 text-[11px] text-faint">
                <span className={st.tone}>{st.text}</span>
                {b.role === "bundle" && <span>bundle</span>}
                {b.role === "snipe" && <span>snipe</span>}
                {view.mode === "pro" && b.role !== "bundle" && <span>espera {fmtMs(b.delayMs ?? 0)}</span>}
                {b.sentAfterMs != null && <span title="Envío, en ms desde la confirmación de la creación">salió T+{fmtMs(b.sentAfterMs)}</span>}
                {b.confirmedAfterMs != null && <span title="Confirmación, en ms desde la confirmación de la creación">confirmó T+{fmtMs(b.confirmedAfterMs)}</span>}
              </div>
              {b.reason && <p className="truncate pl-5.5 text-[11px] text-sell">{b.reason}</p>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
