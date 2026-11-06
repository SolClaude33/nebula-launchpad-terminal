"use client";

// Tarjeta de una automatización: estado, progreso, «incl. dev», acciones del ciclo de vida (REQ-AUTO-006)
// y registro de ejecuciones por intento con «Cargar anteriores» (REQ-AUTO-007).
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronDown, CircleSlash, Copy, Loader2, Pause, PauseCircle, Pencil, Play, RotateCcw, Square, Trash2, XCircle } from "lucide-react";
import { act, ACTIVE, useNow, fmtDuration, fmtIn, loadExecutions, STATUS_LABEL, STATUS_TONE, type Action, type AutoView, type Execution } from "@/lib/automations";
import { clock, fmtSol, fmtTokens, fmtUsd, shortAddr } from "@/lib/format";
import { Address } from "@/components/address";

const DEC = 6;
const amt = (side: "buy" | "sell", v: string | null | undefined) => (v == null ? "—" : side === "buy" ? fmtSol(Number(v) / 1e9, 4) : `${fmtTokens(Number(v) / 10 ** DEC)} tok`);

export function StatusChip({ status }: { status: AutoView["status"] }) {
  return (
    <span className={`chip h-5 px-2 text-[10.5px] ${STATUS_TONE[status]}`}>
      {status === "RUNNING" && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function describe(t: AutoView) {
  const c = t.config;
  if (c.type === "dca") {
    const a = c.amount.kind === "fixed" ? amt(c.side, c.amount.each) : `${amt(c.side, c.amount.min)} → ${amt(c.side, c.amount.max)}`;
    return `${a} por wallet cada ${fmtDuration(c.intervalSec)}`;
  }
  return c.targets.map((x) => `${fmtUsd(x.mcUsd)}${c.side === "buy" ? ` · ${amt("buy", x.lamportsEach)}` : ` · ${x.pct} %`}`).join("  →  ");
}

function progressLine(t: AutoView) {
  const p = t.progress;
  if ("executions" in p) {
    const parts = [`${p.executions}${p.planned !== null ? ` / ${p.planned}` : ""} ejecuciones`];
    if (p.total) parts.push(`${amt(t.side, p.spent)} de ${amt(t.side, p.total)}`);
    else parts.push(`${amt(t.side, p.spent)} ${t.side === "buy" ? "gastados" : "vendidos"}`);
    const pct = p.total ? Number(p.spent) / Number(p.total) : p.planned ? p.executions / p.planned : null;
    return { text: parts.join(" · "), pct };
  }
  return { text: `${p.fired} / ${p.targets} objetivos${p.next !== null ? ` · siguiente ${fmtUsd(p.next)}` : ""}`, pct: p.fired / p.targets };
}

export function TaskCard({ t, onEdit, onChanged, compact = false, open: openInit = false }: { t: AutoView; onEdit?: (t: AutoView) => void; onChanged: () => void; compact?: boolean; open?: boolean }) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [open, setOpen] = useState(openInit);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const run = async (a: Action) => {
    setBusy(a);
    await act(t.id, a);
    setBusy(null);
    setConfirmDelete(false);
    onChanged();
  };
  const pr = progressLine(t);
  const s = t.state;
  const now = useNow();
  const final = !ACTIVE.includes(t.status);
  const btn = (a: Action, label: string, Icon: React.ComponentType<{ className?: string }>, extra = "") => (
    <button onClick={() => run(a)} disabled={!!busy} className={`btn h-7 px-2.5 text-[12px] ${extra}`}>
      {busy === a ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Icon className="size-3.5" aria-hidden />} {label}
    </button>
  );

  return (
    <article className={`panel ${compact ? "p-3" : "p-4"}`} aria-label={t.label}>
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ${t.side === "buy" ? "bg-[var(--buy-soft)] text-buy" : "bg-[var(--sell-soft)] text-sell"}`} aria-label={t.side === "buy" ? "compra" : "venta"}>
          {t.side === "buy" ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className={`truncate font-medium ${compact ? "text-[12.5px]" : "text-[14px]"}`}>{t.label}</h3>
            <StatusChip status={t.status} />
            {t.includesDev && <span className="chip h-5 px-1.5 text-[10.5px] text-warn" title="La tarea opera también con la wallet dev">incl. dev</span>}
            {!compact && t.generation > 1 && <span className="chip h-5 px-1.5 text-[10.5px]">intento {t.generation}</span>}
          </div>
          <p className={`mt-0.5 text-muted ${compact ? "text-[11.5px]" : "text-[12.5px]"}`}>
            {!compact && (
              <>
                <Link href={`/t/${t.mint}`} className="text-accent-b hover:underline">
                  {t.symbol ? `$${t.symbol}` : shortAddr(t.mint)}
                </Link>{" "}
                ·{" "}
              </>
            )}
            <span className="num">{describe(t)}</span> · {t.wallets.length} wallets
          </p>
        </div>
      </div>

      <div className="mt-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px]">
          <span className="num mr-auto text-muted">{pr.text}</span>
          {t.status === "RUNNING" && s.nextAt && !s.waiting && t.type === "dca" && <span className="num text-faint">próxima {fmtIn(s.nextAt, now)}</span>}
          {!compact && s.endsAt && ACTIVE.includes(t.status) && <span className="num text-faint">{t.type === "dca" ? "termina" : "caduca"} {fmtIn(s.endsAt, now)}</span>}
        </div>
        {pr.pct !== null && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, pr.pct) * 100)} aria-label="Progreso">
            <div className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent-a),var(--accent-b))] transition-[width] duration-500" style={{ width: `${Math.min(1, pr.pct) * 100}%` }} />
          </div>
        )}
        {t.status === "RUNNING" && s.waiting && <p className="mt-1.5 text-[11.5px] text-muted">⏳ {s.waiting}</p>}
        {s.lastError && !final && <p className="mt-1.5 text-[11.5px] text-warn">{t.status === "PAUSED" ? "En pausa: " : `Error ${s.consecErrors}/${t.config.maxErrors}: `}{s.lastError}</p>}
        {final && s.endReason && <p className={`mt-1.5 text-[11.5px] ${t.status === "FAILED" ? "text-sell" : "text-muted"}`}>{s.endReason}</p>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {t.status === "IDLE" && btn("start", "Iniciar", Play, "btn-buy")}
        {t.status === "RUNNING" && btn("pause", "Pausar", Pause)}
        {t.status === "PAUSED" && btn("resume", "Reanudar", Play, "btn-buy")}
        {ACTIVE.includes(t.status) && btn("stop", "Parar", Square)}
        {(t.status === "IDLE" || t.status === "PAUSED") && onEdit && (
          <button onClick={() => onEdit(t)} disabled={!!busy} className="btn h-7 px-2.5 text-[12px]">
            <Pencil className="size-3.5" aria-hidden /> Editar
          </button>
        )}
        {final && btn("rerun", "Ejecutar de nuevo", RotateCcw)}
        {!compact && btn("duplicate", "Duplicar", Copy, "btn-ghost")}
        {!compact &&
          (t.status === "IDLE" || final) &&
          (confirmDelete ? (
            <span className="inline-flex items-center gap-1.5 text-[12px]">
              ¿Borrar?
              {btn("delete", "Sí, borrar", Trash2, "btn-sell")}
              <button onClick={() => setConfirmDelete(false)} className="btn btn-ghost h-7 px-2 text-[12px]">
                No
              </button>
            </span>
          ) : (
            <button onClick={() => setConfirmDelete(true)} disabled={!!busy} className="btn btn-ghost h-7 px-2.5 text-[12px]" title="Solo se borra una tarea parada">
              <Trash2 className="size-3.5" aria-hidden /> Borrar
            </button>
          ))}
        {!compact && (
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="btn btn-ghost ml-auto h-7 px-2.5 text-[12px]">
            Registro <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
          </button>
        )}
      </div>
      {open && !compact && <ExecutionLog task={t} />}
    </article>
  );
}

/** REQ-AUTO-007: ejecuciones por intento (hora, wallet, lado, monto, firma, estado, reintentos), paginadas. */
export function ExecutionLog({ task }: { task: AutoView }) {
  const [log, setLog] = useState<{ items: Execution[]; before: number | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const stamp = `${task.updatedAt}:${task.state.inFlight}`;
  const refresh = useCallback(async () => {
    const r = await loadExecutions(task.id).catch(() => null);
    if (!r) return;
    // la primera página se actualiza; lo cargado con «Cargar anteriores» se conserva
    setLog((prev) => {
      if (!prev) return r;
      const fresh = new Set(r.items.map((x) => x.cursor));
      const oldest = r.items.at(-1)?.cursor ?? Infinity;
      return { items: [...r.items, ...prev.items.filter((x) => !fresh.has(x.cursor) && x.cursor < oldest)], before: prev.items.length > r.items.length ? prev.before : r.before };
    });
  }, [task.id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- recarga cuando la tarea avanza
    void refresh();
  }, [refresh, stamp]);
  const more = async () => {
    if (!log?.before) return;
    setLoading(true);
    const r = await loadExecutions(task.id, log.before).catch(() => null);
    if (r) setLog((p) => ({ items: [...(p?.items ?? []), ...r.items], before: r.before }));
    setLoading(false);
  };
  const items = log?.items ?? null;
  const before = log?.before ?? null;
  if (!items) return <div className="skeleton mt-3 h-16" aria-busy="true" />;
  if (items.length === 0) return <p className="mt-3 rounded-[var(--radius-sm)] border border-line bg-surface-2/40 p-3 text-[12px] text-faint">Aún no hay ejecuciones.</p>;
  return (
    <div className="mt-3 border-t border-line pt-3">
      <ol className="space-y-2">
        {items.map((x) => (
          <li key={x.cursor} className="rounded-[var(--radius-sm)] border border-line bg-surface-2/40">
            <div className="flex items-center gap-2 border-b border-line/60 px-3 py-1.5 text-[11.5px]">
              <span className="telemetry">Intento {x.generation} · ejecución {x.seq + 1}</span>
              {x.target !== null && <span className="chip h-4 px-1.5 text-[10px]">objetivo {x.target + 1}</span>}
              {x.mcUsd !== null && <span className="num text-faint">MC {fmtUsd(x.mcUsd)}</span>}
              <span className="num ml-auto text-faint">{clock(x.at)}</span>
            </div>
            <table className="w-full table-fixed text-[12px]">
              <colgroup>
                <col className="w-9" />
                <col className="w-[28%]" />
                <col className="w-[14%]" />
                <col className="w-[18%]" />
                <col />
              </colgroup>
              <thead className="sr-only">
                <tr>
                  <th>Estado</th>
                  <th>Wallet</th>
                  <th>Lado</th>
                  <th>Monto</th>
                  <th>Firma o motivo</th>
                </tr>
              </thead>
              <tbody>
                {x.items.map((i) => (
                  <tr key={i.walletId} className="border-t border-line/40 first:border-t-0">
                    <td className="w-7 py-1.5 pl-3">
                      {i.status === "OK" ? <CheckCircle2 className="size-3.5 text-buy" aria-label="entró" /> : i.status === "FAILED" ? <XCircle className="size-3.5 text-sell" aria-label="falló" /> : i.status === "SKIPPED" ? <CircleSlash className="size-3.5 text-faint" aria-label="omitida" /> : <PauseCircle className="size-3.5 text-warn" aria-label="pendiente" />}
                    </td>
                    <td className="truncate py-1.5">{i.label ?? "wallet borrada"}</td>
                    <td className={`py-1.5 ${i.side === "buy" ? "text-buy" : "text-sell"}`}>{i.side === "buy" ? "compra" : "venta"}</td>
                    <td className="num py-1.5">{amt(i.side, i.amount)}</td>
                    <td className="py-1.5 pr-3 text-right">
                      {i.signature && i.status !== "SKIPPED" ? <Address value={i.signature} kind="tx" head={6} tail={4} className="text-[11px] text-muted" /> : <span className="text-[11px] text-faint">{i.reason ?? (i.status === "PENDING" ? "pendiente" : "")}</span>}
                      {i.retries > 0 && <span className="chip ml-1.5 h-4 px-1.5 text-[10px] text-warn">{i.retries} {i.retries === 1 ? "reintento" : "reintentos"}</span>}
                      {i.status === "FAILED" && i.reason && i.signature && <span className="block text-[11px] text-sell">{i.reason}</span>}
                    </td>
                  </tr>
                ))}
                {x.items.length === 0 && (
                  <tr>
                    <td className="px-3 py-1.5 text-[11.5px] text-faint">Preparando la orden…</td>
                  </tr>
                )}
              </tbody>
            </table>
          </li>
        ))}
      </ol>
      {before && (
        <button onClick={more} disabled={loading} className="btn btn-ghost mt-2 h-8 w-full text-[12px]">
          {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Cargar anteriores
        </button>
      )}
    </div>
  );
}
