"use client";

// /automations (§8.2): todas las tareas de DCA y órdenes límite, con su ciclo de vida y su registro.
// ?new=<mint> abre el formulario con el token elegido (desde el Live Workspace); ?task=<id> abre su registro.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, Plus } from "lucide-react";
import { AutomationForm } from "@/components/automations/automation-form";
import { TaskCard } from "@/components/automations/task-card";
import { ACTIVE, useAutomations, type AutoView } from "@/lib/automations";
import { shortAddr } from "@/lib/format";

type Filter = "active" | "done" | "all";

export function AutomationsView() {
  const params = useSearchParams();
  const router = useRouter();
  const mint = params.get("mint");
  const focus = params.get("task");
  const newFor = params.get("new");
  const { items, error, reload } = useAutomations(mint);
  const [filter, setFilter] = useState<Filter>("active");
  const [form, setForm] = useState<{ edit: AutoView | null; mint: string | null } | null>(newFor !== null ? { edit: null, mint: newFor || null } : null);

  const counts = useMemo(() => {
    const a = (items ?? []).filter((t) => ACTIVE.includes(t.status)).length;
    return { active: a, done: (items ?? []).length - a, all: (items ?? []).length };
  }, [items]);
  const shown = (items ?? []).filter((t) => filter === "all" || (filter === "active") === ACTIVE.includes(t.status));
  const close = () => {
    setForm(null);
    if (newFor !== null) router.replace(mint ? `/automations?mint=${mint}` : "/automations");
  };

  return (
    <div className="mx-auto max-w-[1080px] p-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="telemetry">Sistema</p>
          <h1 className="font-display mt-1 text-[30px] tracking-[-0.01em]">Automatizaciones</h1>
          <p className="mt-1 max-w-[620px] text-[13px] text-muted">
            DCA y órdenes límite sobre tu propia posición. Corren en el servidor local mientras la bóveda está abierta; al bloquear o reiniciar quedan en pausa y solo se reanudan si lo confirmas. Pausar o parar nunca vende nada.
          </p>
        </div>
        <button onClick={() => setForm({ edit: null, mint })} className="cta cta-fill flex h-10 shrink-0 items-center gap-2 px-4 text-[13px] font-semibold">
          <Plus className="size-4" aria-hidden /> Nueva automatización
        </button>
      </div>

      <div className="mt-5 flex items-center gap-2">
        <div role="tablist" aria-label="Filtrar" className="inline-flex gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
          {(
            [
              ["active", "Activas"],
              ["done", "Terminadas"],
              ["all", "Todas"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={`flex h-7 items-center gap-1.5 rounded-[6px] px-3 text-[12.5px] font-medium transition-colors ${filter === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
              {l} <span className="num text-[11px] text-faint">{counts[k]}</span>
            </button>
          ))}
        </div>
        {mint && (
          <span className="chip h-7 px-2.5 text-[12px]">
            Token {shortAddr(mint)}
            <Link href="/automations" className="text-faint hover:text-fg" aria-label="Quitar el filtro de token">
              ×
            </Link>
          </span>
        )}
      </div>

      {error && <p className="mt-4 rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-3 text-[12.5px] text-sell">{error}</p>}
      {items === null && !error ? (
        <div className="mt-4 space-y-3">
          <div className="skeleton h-28" aria-busy="true" />
          <div className="skeleton h-28" aria-busy="true" />
        </div>
      ) : shown.length === 0 ? (
        <div className="panel reticle mt-4 grid place-items-center gap-2 p-10 text-center">
          <Bot className="size-7 text-accent" aria-hidden />
          <p className="text-[14px]">{filter === "active" ? "No hay automatizaciones activas." : "Nada por aquí todavía."}</p>
          <p className="max-w-[440px] text-[12.5px] text-muted">Un DCA compra o vende un monto fijo (o una rampa fija entre mínimo y máximo) a intervalos; una orden límite actúa cuando el market cap en USD cruza tus objetivos.</p>
          <button onClick={() => setForm({ edit: null, mint })} className="btn mt-2 h-9 px-4 text-[13px]">
            <Plus className="size-4" aria-hidden /> Crear la primera
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {shown.map((t) => (
            <TaskCard key={t.id} t={t} open={t.id === focus} onEdit={(x) => setForm({ edit: x, mint: x.mint })} onChanged={reload} />
          ))}
        </div>
      )}

      {form && (
        <AutomationForm
          initial={form.edit}
          mint={form.mint}
          onClose={close}
          onSaved={() => {
            close();
            void reload();
          }}
        />
      )}
    </div>
  );
}
