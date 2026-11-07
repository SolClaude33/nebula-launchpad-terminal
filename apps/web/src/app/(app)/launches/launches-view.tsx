"use client";

// /launches y /launches/drafts (§8.2, REQ-LAUNCH-004/020): lanzamientos hechos y borradores sin lanzar.
// Los borradores viven en la API local; «Continuar» abre el asistente con ese borrador.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ArrowUpRight, FilePen, Loader2, Play, Plus, Rocket, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { fmtSol, shortAddr, timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";

type LaunchItem = {
  id: string;
  status: "PREPARED" | "SCHEDULED" | "CREATING" | "CREATED" | "BUYING" | "DONE" | "FAILED" | "PAUSED" | "CANCELLED";
  pausedFrom: string | null;
  mint: string;
  name: string;
  symbol: string;
  mode: "quick" | "manual";
  devBuyLamports: string;
  holders: number;
  buys: { ok: number; failed: number; skipped: number; pending: number };
  createSignature: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  scheduledAt?: number | null;
};
type DraftItem = { id: string; name: string; symbol: string; updatedAt: number; createdAt: number; launch: { status: string; mint: string } | null; image: string | null; mode: string | null };

const STATUS: Record<LaunchItem["status"], { label: string; cls: string }> = {
  PREPARED: { label: "Preparado", cls: "" },
  SCHEDULED: { label: "Programado", cls: "border-accent-b/30 text-accent-b" },
  CREATING: { label: "Creando", cls: "border-accent-b/30 text-accent-b" },
  CREATED: { label: "Creado", cls: "border-accent-b/30 text-accent-b" },
  BUYING: { label: "Comprando", cls: "border-accent-b/30 text-accent-b" },
  DONE: { label: "Lanzado", cls: "border-buy/30 text-buy" },
  FAILED: { label: "Fallido", cls: "border-sell/30 text-sell" },
  PAUSED: { label: "En pausa", cls: "border-warn/30 text-warn" },
  CANCELLED: { label: "Cancelado", cls: "" },
};

export function LaunchesView({ tab }: { tab: "launches" | "drafts" }) {
  const [counts, setCounts] = useState<{ launches: number | null; drafts: number | null }>({ launches: null, drafts: null });
  // Callbacks estables: si cambiaran en cada render, el efecto de carga de las listas se relanzaría sin fin.
  const onLaunches = useCallback((n: number) => setCounts((c) => (c.launches === n ? c : { ...c, launches: n })), []);
  const onDrafts = useCallback((n: number) => setCounts((c) => (c.drafts === n ? c : { ...c, drafts: n })), []);
  return (
    <div className="mx-auto max-w-[1080px] p-6 pb-16">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="telemetry">Operar</p>
          <h1 className="font-display mt-1 text-[30px] tracking-[-0.01em]">Lanzamientos</h1>
          <p className="mt-1 max-w-[620px] text-[13px] text-muted">Lo que ya está en cadena y los borradores que dejaste a medias. Un borrador se guarda solo mientras lo editas y sobrevive a cerrar la app.</p>
        </div>
        <Link href="/launch/new?new=1" className="cta cta-fill flex h-10 shrink-0 items-center gap-2 px-4 text-[13px] font-semibold">
          <Plus className="size-4" aria-hidden /> Nuevo lanzamiento
        </Link>
      </div>
      <nav aria-label="Secciones" className="mt-5 inline-flex gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
        {(
          [
            ["launches", "/launches", "Lanzados", counts.launches],
            ["drafts", "/launches/drafts", "Borradores", counts.drafts],
          ] as const
        ).map(([k, href, l, n]) => (
          <Link key={k} href={href} aria-current={tab === k ? "page" : undefined} className={`flex h-7 items-center gap-1.5 rounded-[6px] px-3 text-[12.5px] font-medium transition-colors ${tab === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
            {l} {n !== null && <span className="num text-[11px] text-faint">{n}</span>}
          </Link>
        ))}
      </nav>
      {tab === "launches" ? <LaunchList onCount={onLaunches} onDrafts={onDrafts} /> : <DraftList onCount={onDrafts} />}
    </div>
  );
}

function LaunchList({ onCount, onDrafts }: { onCount: (n: number) => void; onDrafts: (n: number) => void }) {
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<LaunchItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: LaunchItem[] }>(`/launches?all=1&archived=${archived ? 1 : 0}`);
      setItems(r.items);
      setError(null);
      if (!archived) onCount(r.items.length);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, [archived, onCount]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial desde la API local
    void load();
    api<{ items: DraftItem[] }>("/drafts").then((r) => onDrafts(r.items.length), () => {});
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load, onDrafts]);

  const act = async (id: string, what: "resume" | "archive" | "unarchive") => {
    setBusy(id);
    try {
      if (what === "resume") await api(`/launches/${id}/resume`, { method: "POST", body: {} });
      else await api(`/launches/${id}/archive`, { method: "POST", body: { archived: what === "archive" } });
      toast({ tone: "info", title: what === "resume" ? "Lanzamiento reanudado" : what === "archive" ? "Lanzamiento archivado" : "Lanzamiento recuperado" });
      await load();
    } catch (e) {
      toast({ tone: "error", title: "No se pudo completar", body: (e as ApiError).message });
    }
    setBusy(null);
  };

  return (
    <section className="mt-4" aria-label="Lanzamientos">
      <div className="mb-3 flex justify-end">
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="accent-[var(--accent-b)]" /> Ver archivados
        </label>
      </div>
      {error && <p className="rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-3 text-[12.5px] text-sell">{error}</p>}
      {items === null && !error ? (
        <div className="space-y-2">
          <div className="skeleton h-20" aria-busy="true" />
          <div className="skeleton h-20" aria-busy="true" />
        </div>
      ) : items && items.length === 0 ? (
        <Empty
          icon={<Rocket className="size-5" aria-hidden />}
          title={archived ? "No hay lanzamientos archivados" : "Aún no has lanzado ningún token"}
          body={archived ? "Los que archives aparecerán aquí." : "El asistente te guía en 4 pasos, con dry-run antes de enviar nada."}
          cta={archived ? null : { href: "/launch/new?new=1", label: "Lanzar token" }}
        />
      ) : (
        <ul className="space-y-2">
          {items?.map((l) => {
            const st = STATUS[l.status] ?? STATUS.PREPARED;
            const live = ["DONE", "BUYING", "CREATED", "PAUSED"].includes(l.status) && l.createSignature;
            return (
              <li key={l.id} className="panel hover-glow flex items-center gap-4 p-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface-2 text-[12px] font-semibold">{l.symbol.slice(0, 3)}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[14px] font-medium">
                    ${l.symbol} <span className="truncate font-normal text-muted">{l.name}</span>
                    <span className={`chip h-5 ${st.cls}`}>{st.label}</span>
                  </p>
                  <p className="num mt-0.5 text-[11.5px] text-faint">
                    {shortAddr(l.mint)} · {l.mode === "quick" ? `Quick · ${l.buys.ok}/${l.holders} compras${l.buys.failed ? ` · ${l.buys.failed} fallidas` : ""}${l.buys.skipped ? ` · ${l.buys.skipped} omitidas` : ""}` : "Manual"} · dev buy {fmtSol(Number(l.devBuyLamports) / 1e9, 3)} ·{" "}
                    {l.status === "SCHEDULED" && l.scheduledAt ? `programado ${new Date(l.scheduledAt).toLocaleString("es-ES")}` : `hace ${timeAgo(l.createdAt)}`}
                  </p>
                  {l.error && <p className="mt-1 truncate text-[12px] text-sell" title={l.error}>{l.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {l.status === "PAUSED" && (
                    <button onClick={() => act(l.id, "resume")} disabled={busy === l.id} className="btn h-8 px-3 text-[12px]">
                      {busy === l.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />} Reanudar
                    </button>
                  )}
                  {live && (
                    <Link href={`/t/${l.mint}`} className="btn h-8 px-3 text-[12px]">
                      <ArrowUpRight className="size-3.5" aria-hidden /> Abrir en Live
                    </Link>
                  )}
                  {!["CREATING", "CREATED", "BUYING"].includes(l.status) && (
                    <button onClick={() => act(l.id, archived ? "unarchive" : "archive")} disabled={busy === l.id} className="btn btn-ghost size-8 p-0" aria-label={archived ? `Recuperar $${l.symbol}` : `Archivar $${l.symbol}`} title={archived ? "Recuperar" : "Archivar"}>
                      {archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DraftList({ onCount }: { onCount: (n: number) => void }) {
  const router = useRouter();
  const [items, setItems] = useState<DraftItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ items: DraftItem[] }>("/drafts");
      setItems(r.items);
      onCount(r.items.length);
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, [onCount]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial desde la API local
    void load();
  }, [load]);

  const discard = async (d: DraftItem) => {
    if (!confirm(`¿Descartar el borrador ${d.symbol ? `$${d.symbol}` : "sin nombre"}? No se puede deshacer.`)) return;
    try {
      await api(`/drafts/${d.id}`, { method: "DELETE" });
      toast({ tone: "info", title: "Borrador descartado" });
      await load();
    } catch (e) {
      toast({ tone: "error", title: "No se pudo descartar", body: (e as ApiError).message });
    }
  };

  return (
    <section className="mt-4" aria-label="Borradores">
      {error && <p className="rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-3 text-[12.5px] text-sell">{error}</p>}
      {items === null && !error ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="skeleton h-28" aria-busy="true" />
          <div className="skeleton h-28" aria-busy="true" />
        </div>
      ) : items && items.length === 0 ? (
        <Empty icon={<FilePen className="size-5" aria-hidden />} title="No hay borradores" body="Al empezar un lanzamiento se guarda solo. Si cierras el asistente con Esc, lo retomas desde aquí." cta={{ href: "/launch/new?new=1", label: "Empezar un borrador" }} />
      ) : (
        <ul className="grid grid-cols-2 gap-3">
          {items?.map((d) => (
            <li key={d.id} className="panel hover-glow flex gap-4 p-4">
              <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-md)] border border-line bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {d.image ? <img src={d.image} alt="" className="size-full object-cover" /> : <FilePen className="size-5 text-faint" aria-hidden />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">
                  {d.symbol ? `$${d.symbol}` : <span className="text-muted">Sin símbolo</span>} <span className="font-normal text-muted">{d.name || "Sin nombre"}</span>
                </p>
                <p className="num mt-0.5 text-[11.5px] text-faint">
                  Editado hace {timeAgo(d.updatedAt)} · {d.mode === "manual" ? "Manual" : "Quick"}
                  {d.launch?.status === "PREPARED" && " · dry-run hecho"}
                  {d.launch?.status === "FAILED" && " · el último intento falló"}
                </p>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => router.push(`/launch/new?draft=${encodeURIComponent(d.id)}`)} className="cta cta-fill flex h-8 items-center gap-1.5 px-3 text-[12px] font-semibold">
                    <FilePen className="size-3.5" aria-hidden /> Continuar
                  </button>
                  <button onClick={() => discard(d)} className="btn btn-ghost h-8 px-2.5 text-[12px]" aria-label={`Descartar el borrador ${d.symbol || d.name || ""}`}>
                    <Trash2 className="size-3.5" aria-hidden /> Descartar
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Empty({ icon, title, body, cta }: { icon: React.ReactNode; title: string; body: string; cta: { href: string; label: string } | null }) {
  return (
    <div className="panel reticle grid place-items-center px-6 py-14 text-center">
      <span className="grid size-11 place-items-center rounded-full border border-line bg-surface-2 text-accent-b">{icon}</span>
      <p className="mt-4 text-[15px] font-semibold">{title}</p>
      <p className="mt-1 max-w-[420px] text-[12.5px] text-muted">{body}</p>
      {cta && (
        <Link href={cta.href} className="cta cta-fill mt-5 inline-flex h-9 items-center gap-2 px-4 text-[12.5px] font-semibold">
          <Plus className="size-3.5" aria-hidden /> {cta.label}
        </Link>
      )}
    </div>
  );
}
