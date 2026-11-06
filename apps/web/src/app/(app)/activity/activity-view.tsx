"use client";

// /activity (REQ-LOG-001): registro local de lo que mueve fondos o toca la seguridad — exportaciones,
// retiros, lanzamientos, órdenes, automatizaciones y cambios de ajustes. Solo lectura, paginado.
import { useCallback, useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import type { ActivityDto } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { DiagnosticsButton } from "@/components/settings/diagnostics-button";

const FILTERS: [string, string][] = [
  ["", "Todo"],
  ["launch", "Lanzamientos"],
  ["trade", "Órdenes"],
  ["funds", "Fondos"],
  ["wallets", "Wallets"],
  ["auto", "Automatizaciones"],
  ["rewards", "Comisiones"],
  ["vault", "Bóveda"],
  ["settings", "Ajustes"],
];

const LABEL: Record<string, string> = { launch: "Lanzamiento", trade: "Orden", funds: "Fondos", wallets: "Wallets", auto: "Automatización", rewards: "Comisiones", vault: "Bóveda", settings: "Ajustes", tasks: "Tareas", dev: "Pruebas", diagnostics: "Diagnóstico", backup: "Copia" };
const SENSITIVE = /^(wallets\.export|wallets\.delete|funds\.withdraw|vault\.(password|restore|backup)|diagnostics)/;

const PAGE = 50;

export function ActivityView() {
  const [kind, setKind] = useState("");
  const [items, setItems] = useState<ActivityDto[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (k: string, before?: number) => {
    try {
      const r = await api<{ items: ActivityDto[] }>(`/activity?limit=${PAGE}${k ? `&kind=${k}` : ""}${before ? `&before=${before}` : ""}`);
      setItems((prev) => (before ? [...(prev ?? []), ...r.items] : r.items));
      setMore(r.items.length === PAGE);
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial desde la API local
    void load(kind);
  }, [kind, load]);

  return (
    <div className="mx-auto max-w-[980px] p-6 pb-16">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="telemetry">Sistema</p>
          <h1 className="font-display mt-1 text-[30px] tracking-[-0.01em]">Actividad</h1>
          <p className="mt-1 max-w-[620px] text-[13px] text-muted">Registro local de lo que hiciste: exportaciones, retiros, lanzamientos, órdenes y cambios de ajustes. Nunca guarda claves ni secretos.</p>
        </div>
        <DiagnosticsButton className="shrink-0" />
      </div>

      <div role="tablist" aria-label="Filtrar por tipo" className="mt-5 inline-flex flex-wrap gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
        {FILTERS.map(([k, l]) => (
          <button key={k || "all"} role="tab" aria-selected={kind === k} onClick={() => (setItems(null), setKind(k))} className={`h-7 rounded-[6px] px-3 text-[12.5px] font-medium transition-colors ${kind === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
            {l}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-3 text-[12.5px] text-sell">{error}</p>}
      <section className="panel reticle mt-4" aria-label="Eventos">
        {items === null && !error ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-9" aria-busy="true" />
            ))}
          </div>
        ) : items && items.length === 0 ? (
          <p className="grid place-items-center gap-2 px-6 py-14 text-center text-[13px] text-muted">
            <ScrollText className="size-5 text-faint" aria-hidden />
            Nada registrado {kind ? "de este tipo " : ""}todavía.
          </p>
        ) : (
          <ol className="divide-y divide-line">
            {items?.map((a) => {
              const group = a.kind.split(".")[0];
              return (
                <li key={a.id} className="grid grid-cols-[132px_120px_minmax(0,1fr)] items-baseline gap-3 px-4 py-2.5 text-[12.5px]">
                  <time dateTime={new Date(a.at).toISOString()} className="num text-[11.5px] text-faint">
                    {new Date(a.at).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </time>
                  <span className={`chip h-5 w-fit ${SENSITIVE.test(a.kind) ? "border-warn/30 text-warn" : ""}`} title={a.kind}>
                    {LABEL[group] ?? group}
                  </span>
                  <span className="min-w-0 break-words text-fg">{a.detail}</span>
                </li>
              );
            })}
          </ol>
        )}
        {more && items && (
          <div className="border-t border-line p-3 text-center">
            <button onClick={() => load(kind, items[items.length - 1]?.id)} className="btn h-8 px-3 text-[12px]">
              Cargar anteriores
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
