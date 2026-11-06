"use client";

import { CheckCircle2, CircleSlash, ExternalLink, Info, PauseCircle, TriangleAlert, X, XCircle } from "lucide-react";
import { useToasts, type ToastTone } from "@/lib/toast";

const toneIcon: Record<ToastTone, React.ReactNode> = {
  buy: <CheckCircle2 className="size-4 text-buy" aria-hidden />,
  sell: <CheckCircle2 className="size-4 text-sell" aria-hidden />,
  info: <Info className="size-4 text-accent-b" aria-hidden />,
  warn: <TriangleAlert className="size-4 text-warn" aria-hidden />,
  error: <XCircle className="size-4 text-sell" aria-hidden />,
};

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-5 bottom-5 z-[80] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role="status" className="rise glass pointer-events-auto rounded-[var(--radius-md)] p-3.5 shadow-[var(--shadow-float)]">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5">{toneIcon[t.tone]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{t.title}</p>
              {t.body && <p className="mt-0.5 text-[12.5px] text-muted">{t.body}</p>}
            </div>
            <button onClick={() => dismiss(t.id)} aria-label="Cerrar aviso" className="btn-ghost -m-1 grid size-6 place-items-center rounded-md">
              <X className="size-3.5" />
            </button>
          </div>
          {t.lines && (
            <ul className="mt-2.5 space-y-1 border-t border-line pt-2.5">
              {t.lines.map((l, i) => (
                <li key={i} className="flex items-center gap-2 text-[12px]">
                  {l.status === "ok" ? (
                    <CheckCircle2 className="size-3.5 text-buy" aria-hidden />
                  ) : l.status === "failed" ? (
                    <XCircle className="size-3.5 text-sell" aria-hidden />
                  ) : l.status === "pending" ? (
                    <PauseCircle className="size-3.5 text-warn" aria-hidden />
                  ) : (
                    <CircleSlash className="size-3.5 text-faint" aria-hidden />
                  )}
                  <span className="w-20 shrink-0 text-fg">{l.label}</span>
                  <span className="sr-only">{l.status === "ok" ? "entró" : l.status === "failed" ? "falló" : l.status === "pending" ? "pendiente" : "omitida"}</span>
                  <span className="truncate text-muted">{l.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {t.href && (
            <a href={t.href} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12px] text-accent-b hover:underline">
              Ver transacción <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
