"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  Check,
  ClipboardCopy,
  FolderPlus,
  Folder as FolderIcon,
  FolderMinus,
  KeyRound,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Search,
  Send,
  Split,
  Star,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { BUILTIN_ROLES, ROLE_RE, type FolderDto, type ImportRow, type WalletDto } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Address } from "@/components/address";
import { Modal, RevealDialog, StepUpDialog } from "./dialogs";

type Kind = "wallet" | "funder";
const ROW_H = 46;

export function WalletsView({ kind }: { kind: Kind }) {
  const [wallets, setWallets] = useState<WalletDto[] | null>(null);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [folder, setFolder] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<null | "create" | "import" | "export" | "delete" | "role" | "folder">(null);
  const [revealed, setRevealed] = useState<{ label: string; address: string; secretKey: string }[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      const [w, f] = await Promise.all([api<{ wallets: WalletDto[] }>(`/wallets?archived=${showArchived ? 1 : 0}`), api<{ folders: FolderDto[] }>("/folders")]);
      setWallets(w.wallets);
      setFolders(f.folders);
      setLoadError("");
    } catch (e) {
      setLoadError((e as ApiError).message);
    }
  }, [showArchived]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga asíncrona desde la API local; el setState ocurre tras el await
    load();
  }, [load]);

  const ofKind = useMemo(() => (wallets ?? []).filter((w) => w.kind === kind), [wallets, kind]);
  const roles = useMemo(() => [...new Set([...BUILTIN_ROLES, ...ofKind.map((w) => w.role).filter(Boolean)])] as string[], [ofKind]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ofKind.filter(
      (w) =>
        (folder === "all" || (folder === "none" ? w.folderIds.length === 0 : w.folderIds.includes(folder))) &&
        (role === "all" || (role === "none" ? !w.role : w.role === role)) &&
        (!q || w.label.toLowerCase().includes(q) || w.address.toLowerCase().includes(q)),
    );
  }, [ofKind, folder, role, query]);
  const selected = list.filter((w) => sel.has(w.id));
  const allSel = list.length > 0 && selected.length === list.length;

  const toggle = (id: string) => setSel((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast({ tone: "info", title: ok });
      await load();
    } catch (e) {
      toast({ tone: "error", title: "No se pudo completar", body: (e as ApiError).message });
    }
  };

  const copyAddresses = async () => {
    const src = selected.length ? selected : list;
    try {
      await navigator.clipboard.writeText(src.map((w) => w.address).join("\n"));
      toast({ tone: "info", title: `${src.length} direcciones copiadas` });
    } catch {}
  };

  const title = kind === "funder" ? "Funders" : "Wallets";
  const ids = selected.map((w) => w.id);

  return (
    <div className="grid h-[calc(100dvh-80px)] min-h-[600px] grid-cols-[200px_minmax(0,1fr)_280px] gap-3 p-3 xl:grid-cols-[230px_minmax(0,1fr)_300px]">
      {/* ── Carpetas ── */}
      <FoldersColumn folders={folders} wallets={ofKind} current={folder} onPick={setFolder} reload={load} />

      {/* ── Tabla ── */}
      <section aria-label={title} className="panel reticle flex min-h-0 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div>
            <h1 className="font-display text-[26px] leading-none italic">{title}</h1>
            <p className="num mt-1 text-[11.5px] text-faint">
              {ofKind.length} en total · {list.length} visibles · {selected.length} seleccionadas
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setDialog("import")} className="btn h-9">
              <Upload className="size-3.5" aria-hidden /> Importar
            </button>
            <button onClick={() => setDialog("create")} className="cta cta-fill h-9 px-3.5 text-[13px] font-semibold">
              <span className="flex items-center gap-1.5">
                <Plus className="size-4" aria-hidden /> Crear
              </span>
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
            <input aria-label="Buscar por nombre o dirección" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nombre o dirección" className="field h-8 pl-8 text-[12.5px]" />
          </div>
          <select aria-label="Filtrar por rol" value={role} onChange={(e) => setRole(e.target.value)} className="field h-8 w-auto py-0 text-[12.5px]">
            <option value="all">Todos los roles</option>
            <option value="none">Sin rol</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="size-3.5 accent-[var(--accent-a)]" /> Archivadas
          </label>
          <label className="flex cursor-not-allowed items-center gap-1.5 text-[12px] text-faint" title="Necesita leer saldos del RPC (siguiente bloque)">
            <input type="checkbox" disabled className="size-3.5" /> Ocultar vacías
          </label>
          <button onClick={copyAddresses} disabled={list.length === 0} className="btn h-8 text-[12px]">
            <ClipboardCopy className="size-3.5" aria-hidden /> Copiar {selected.length ? "selección" : "todas"}
          </button>
        </div>

        {loadError ? (
          <p className="p-8 text-center text-[13px] text-sell">{loadError}</p>
        ) : wallets === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skeleton h-9" />
            ))}
          </div>
        ) : ofKind.length === 0 ? (
          <EmptyState kind={kind} onCreate={() => setDialog("create")} onImport={() => setDialog("import")} />
        ) : (
          <VirtualTable list={list} folders={folders} sel={sel} toggle={toggle} allSel={allSel} toggleAll={() => setSel(allSel ? new Set() : new Set(list.map((w) => w.id)))} />
        )}
      </section>

      {/* ── Acciones ── */}
      <aside aria-label="Acciones" className="scroll-thin flex min-h-0 flex-col gap-3 overflow-y-auto">
        <div className="panel p-4">
          <p className="telemetry">Selección · {selected.length}</p>
          {selected.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-muted">Marca wallets en la tabla para asignar rol, moverlas, exportarlas o archivarlas.</p>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-1.5">
              <ActionBtn icon={Tag} label="Rol" onClick={() => setDialog("role")} />
              <ActionBtn icon={FolderPlus} label="Carpeta" onClick={() => setDialog("folder")} />
              {kind === "funder" && selected.length === 1 && !selected[0].isDefaultFunder && (
                <ActionBtn icon={Star} label="Predeterminado" onClick={() => run(() => api("/funders/default", { method: "POST", body: { id: selected[0].id } }), "Funder predeterminado cambiado")} />
              )}
              {selected.every((w) => w.archived) ? (
                <ActionBtn icon={ArchiveRestore} label="Restaurar" onClick={() => run(() => api("/wallets", { method: "PATCH", body: { ids, archived: false } }), "Restauradas")} />
              ) : (
                <ActionBtn icon={Archive} label="Archivar" onClick={() => run(() => api("/wallets", { method: "PATCH", body: { ids, archived: true } }).then(() => setSel(new Set())), "Archivadas")} />
              )}
              <ActionBtn icon={KeyRound} label="Exportar" onClick={() => setDialog("export")} />
              <ActionBtn icon={Trash2} label="Borrar" tone="sell" onClick={() => setDialog("delete")} />
            </div>
          )}
        </div>
        <div className="panel p-4">
          <p className="telemetry">Movimientos</p>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <ActionBtn icon={ArrowDownToLine} label="Depositar" disabled />
            <ActionBtn icon={Send} label="Transferir" disabled />
            <ActionBtn icon={Split} label="Dispersar" disabled />
            <ActionBtn icon={Layers} label="Recolectar" disabled />
          </div>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-faint">Saldos, depósito con QR y transferencias necesitan el RPC: llegan con el adaptador de Solana.</p>
        </div>
        {kind === "funder" && (
          <div className="panel p-4 text-[12.5px] text-muted">
            <p className="telemetry mb-2">Funder</p>
            Siempre hay un funder predeterminado (<Star className="inline size-3 text-warn" aria-label="estrella" />). No se puede archivar ni borrar hasta elegir otro.
          </div>
        )}
      </aside>

      {dialog === "create" && <CreateDialog kind={kind} folders={folders} roles={roles} onClose={() => setDialog(null)} onDone={async () => (setDialog(null), await load())} />}
      {dialog === "import" && <ImportDialog kind={kind} folders={folders} onClose={() => setDialog(null)} onDone={load} />}
      {dialog === "role" && <RoleDialog roles={roles} count={ids.length} onClose={() => setDialog(null)} onPick={(r) => run(() => api("/wallets", { method: "PATCH", body: { ids, role: r } }), "Rol asignado").then(() => setDialog(null))} />}
      {dialog === "folder" && <FolderDialog folders={folders} count={ids.length} onClose={() => setDialog(null)} onPick={(fid, op) => run(() => api(`/folders/${fid}/members`, { method: "POST", body: { walletIds: ids, op } }), op === "add" ? "Añadidas a la carpeta" : "Quitadas de la carpeta").then(() => setDialog(null))} />}
      {dialog === "export" && (
        <StepUpDialog
          action="export-keys"
          title={`Exportar ${ids.length} ${ids.length === 1 ? "clave" : "claves"}`}
          body="Las claves se mostrarán una sola vez, con temporizador. El evento queda en el registro de actividad."
          onClose={() => setDialog(null)}
          onToken={async (token) => {
            try {
              const r = await api<{ keys: { label: string; address: string; secretKey: string }[] }>("/wallets/export", { method: "POST", body: { ids }, stepUp: token });
              setDialog(null);
              setRevealed(r.keys);
            } catch (e) {
              setDialog(null);
              toast({ tone: "error", title: "No se pudo exportar", body: (e as ApiError).message });
            }
          }}
        />
      )}
      {dialog === "delete" && (
        <StepUpDialog
          action="delete-wallet"
          danger
          title={`Borrar ${ids.length} ${ids.length === 1 ? "wallet" : "wallets"}`}
          body="Se borra la clave de la bóveda. Sin RPC no podemos confirmar que estén vacías: si tienen fondos, recolecta antes o exporta la clave."
          onClose={() => setDialog(null)}
          onToken={async (token) => {
            setDialog(null);
            await run(() => api("/wallets", { method: "DELETE", body: { ids }, stepUp: token }).then(() => setSel(new Set())), "Wallets borradas");
          }}
        />
      )}
      {revealed && <RevealDialog keys={revealed} onClose={() => setRevealed(null)} />}
    </div>
  );
}

function ActionBtn({ icon: Icon, label, onClick, disabled, tone }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick?: () => void; disabled?: boolean; tone?: "sell" }) {
  return (
    <button onClick={onClick} disabled={disabled} className={`btn h-9 justify-start px-2.5 text-[12.5px] ${tone === "sell" ? "hover:!border-sell/50 hover:!text-sell" : ""}`}>
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

function VirtualTable({ list, folders, sel, toggle, allSel, toggleAll }: { list: WalletDto[]; folders: FolderDto[]; sel: Set<string>; toggle: (id: string) => void; allSel: boolean; toggleAll: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // REQ-WAL-005: solo se renderizan las filas visibles (más un margen)
  const start = Math.max(0, Math.floor(top / ROW_H) - 6);
  const end = Math.min(list.length, Math.ceil((top + h) / ROW_H) + 6);
  const fname = (id: string) => folders.find((f) => f.id === id)?.name ?? "—";
  const cols = "grid-cols-[36px_minmax(120px,1.2fr)_minmax(150px,1.4fr)_96px_minmax(0,1fr)_92px]";
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12.5px]">
      <div role="row" className={`grid ${cols} items-center gap-2 border-b border-line bg-surface-1 px-4 py-2`}>
        <input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Seleccionar todas las visibles" className="size-3.5 accent-[var(--accent-a)]" />
        <span className="telemetry">Nombre</span>
        <span className="telemetry">Dirección</span>
        <span className="telemetry">Rol</span>
        <span className="telemetry">Carpetas</span>
        <span className="telemetry text-right">Saldo</span>
      </div>
      {list.length === 0 ? (
        <p className="p-8 text-center text-muted">Nada coincide con los filtros.</p>
      ) : (
        <div ref={ref} onScroll={(e) => setTop(e.currentTarget.scrollTop)} className="scroll-thin relative min-h-0 flex-1 overflow-y-auto" role="rowgroup">
          <div style={{ height: list.length * ROW_H }} className="relative">
            {list.slice(start, end).map((w, i) => {
              const checked = sel.has(w.id);
              return (
                <div
                  key={w.id}
                  role="row"
                  aria-selected={checked}
                  className={`absolute inset-x-0 grid ${cols} items-center gap-2 border-b border-line/50 px-4 transition-colors ${checked ? "bg-[color-mix(in_oklab,var(--accent-a)_9%,transparent)]" : "hover:bg-surface-2/50"} ${w.archived ? "opacity-55" : ""}`}
                  style={{ top: (start + i) * ROW_H, height: ROW_H }}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggle(w.id)} aria-label={`Seleccionar ${w.label}`} className="size-3.5 accent-[var(--accent-a)]" />
                  <span className="flex min-w-0 items-center gap-1.5 truncate font-medium">
                    {w.isDefaultFunder && <Star className="size-3 shrink-0 fill-warn text-warn" aria-label="predeterminado" />}
                    <span className="truncate">{w.label}</span>
                    {w.archived && <span className="chip h-4 px-1 text-[9.5px]">archivada</span>}
                  </span>
                  <Address value={w.address} head={5} tail={5} className="text-muted" />
                  <span>{w.role ? <span className={`chip h-5 px-1.5 text-[10.5px] ${w.role === "dev" ? "border-warn/30 text-warn" : ""}`}>{w.role}</span> : <span className="text-faint">—</span>}</span>
                  <span className="flex min-w-0 gap-1 overflow-hidden">
                    {w.folderIds.length ? w.folderIds.map((f) => <span key={f} className="chip h-5 shrink-0 px-1.5 text-[10.5px]">{fname(f)}</span>) : <span className="text-faint">—</span>}
                  </span>
                  <span className="num text-right text-faint" title="Sin RPC configurado todavía">
                    sin RPC
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ kind, onCreate, onImport }: { kind: Kind; onCreate: () => void; onImport: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
      <div className="relative grid size-16 place-items-center rounded-full border border-line-strong">
        <span className="absolute inset-2 rounded-full border border-dashed border-accent-b/40" />
        <KeyRound className="size-6 text-accent" aria-hidden />
      </div>
      <h2 className="font-display mt-5 text-[26px] italic">{kind === "funder" ? "Aún no hay funder" : "Aún no hay wallets"}</h2>
      <p className="mt-1.5 max-w-sm text-[13px] text-muted">{kind === "funder" ? "El funder es la wallet desde la que financias las demás. Crea uno o importa una clave existente." : "Crea de 1 a 100 de golpe o importa las que ya tienes. Las claves se cifran en la bóveda al instante."}</p>
      <div className="mt-5 flex gap-2">
        <button onClick={onImport} className="btn h-10 px-4">
          <Upload className="size-4" aria-hidden /> Importar
        </button>
        <button onClick={onCreate} className="cta cta-fill h-10 px-4 text-[13px] font-semibold">
          {kind === "funder" ? "Crear funder" : "Crear wallets"}
        </button>
      </div>
    </div>
  );
}

function FolderItem({ id, label, n, icon, current, onPick }: { id: string; label: string; n: number; icon?: React.ReactNode; current: string; onPick: (id: string) => void }) {
  return (
    <button onClick={() => onPick(id)} aria-current={current === id} className={`flex h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] transition-colors ${current === id ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
      {icon ?? <FolderIcon className="size-3.5 shrink-0" aria-hidden />}
      <span className="flex-1 truncate">{label}</span>
      <span className="num text-[11px] text-faint">{n}</span>
    </button>
  );
}

function FoldersColumn({ folders, wallets, current, onPick, reload }: { folders: FolderDto[]; wallets: WalletDto[]; current: string; onPick: (id: string) => void; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const count = (id: string) => wallets.filter((w) => w.folderIds.includes(id)).length;
  const save = async () => {
    if (!name.trim()) return setAdding(false);
    try {
      await api("/folders", { method: "POST", body: { name } });
      setName("");
      setAdding(false);
      await reload();
    } catch (e) {
      toast({ tone: "error", title: "Carpeta", body: (e as ApiError).message });
    }
  };
  return (
    <nav aria-label="Carpetas" className="panel flex min-h-0 flex-col p-2.5">
      <p className="telemetry px-2 pt-1 pb-2">Carpetas</p>
      <FolderItem current={current} onPick={onPick} id="all" label="Todas" n={wallets.length} icon={<Layers className="size-3.5 shrink-0" aria-hidden />} />
      <FolderItem current={current} onPick={onPick} id="none" label="Sin carpeta" n={wallets.filter((w) => w.folderIds.length === 0).length} icon={<FolderMinus className="size-3.5 shrink-0" aria-hidden />} />
      <div className="my-2 h-px bg-line" />
      <div className="scroll-thin min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {folders.map((f) =>
          editing === f.id ? (
            <RenameRow key={f.id} folder={f} onDone={async () => (setEditing(null), await reload())} />
          ) : (
            <div key={f.id} className="group relative">
              <FolderItem current={current} onPick={onPick} id={f.id} label={f.name} n={count(f.id)} />
              <span className="absolute top-1/2 right-7 hidden -translate-y-1/2 gap-0.5 group-focus-within:flex group-hover:flex">
                <button onClick={() => setEditing(f.id)} aria-label={`Renombrar ${f.name}`} className="btn-ghost grid size-6 place-items-center rounded">
                  <Pencil className="size-3" />
                </button>
                <button
                  onClick={async () => {
                    if (!confirm(`¿Borrar la carpeta «${f.name}»? Las wallets no se borran.`)) return;
                    await api(`/folders/${f.id}`, { method: "DELETE" });
                    if (current === f.id) onPick("all");
                    await reload();
                  }}
                  aria-label={`Borrar ${f.name}`}
                  className="btn-ghost grid size-6 place-items-center rounded"
                >
                  <X className="size-3" />
                </button>
              </span>
            </div>
          ),
        )}
      </div>
      {adding ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="mt-2 flex gap-1"
        >
          <input autoFocus aria-label="Nombre de la carpeta" value={name} onChange={(e) => setName(e.target.value)} onBlur={save} maxLength={40} className="field h-8 text-[12.5px]" />
        </form>
      ) : (
        <button onClick={() => setAdding(true)} className="btn btn-ghost mt-2 h-8 justify-start text-[12.5px]">
          <FolderPlus className="size-3.5" aria-hidden /> Nueva carpeta
        </button>
      )}
    </nav>
  );
}

function RenameRow({ folder, onDone }: { folder: FolderDto; onDone: () => Promise<void> }) {
  const [v, setV] = useState(folder.name);
  const save = async () => {
    if (v.trim() && v !== folder.name) await api(`/folders/${folder.id}`, { method: "PATCH", body: { name: v } }).catch((e) => toast({ tone: "error", title: "Carpeta", body: (e as ApiError).message }));
    await onDone();
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input autoFocus aria-label="Nuevo nombre" value={v} onChange={(e) => setV(e.target.value)} onBlur={save} maxLength={40} className="field h-8 text-[12.5px]" />
    </form>
  );
}

function CreateDialog({ kind, folders, roles, onClose, onDone }: { kind: Kind; folders: FolderDto[]; roles: string[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [count, setCount] = useState(kind === "funder" ? "1" : "10");
  const [role, setRole] = useState(kind === "funder" ? "" : "holder");
  const [folderId, setFolderId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const n = Number(count);
  const invalid = !Number.isInteger(n) || n < 1 || n > 100;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    try {
      await api("/wallets", { method: "POST", body: { count: n, role: role || null, folderId: folderId || null, labelPrefix: prefix || undefined, kind } });
      toast({ tone: "info", title: `${n} ${kind === "funder" ? (n === 1 ? "funder creado" : "funders creados") : "wallets creadas"}`, body: "Claves generadas y cifradas en la bóveda." });
      await onDone();
    } catch (err) {
      toast({ tone: "error", title: "No se pudo crear", body: (err as ApiError).message });
      setBusy(false);
    }
  };
  return (
    <Modal title={kind === "funder" ? "Crear funder" : "Crear wallets"} labelId="create-title" onClose={onClose}>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-[13px]">
            <span className="mb-1.5 block font-medium">Cantidad</span>
            <input autoFocus inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} aria-invalid={invalid} className="field num h-10" />
            <span className={`mt-1 block text-[11.5px] ${invalid ? "text-sell" : "text-faint"}`}>De 1 a 100</span>
          </label>
          <label className="block text-[13px]">
            <span className="mb-1.5 block font-medium">Prefijo del nombre</span>
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder={kind === "funder" ? "Funder" : "Wallet"} maxLength={24} className="field h-10" />
          </label>
        </div>
        {kind === "wallet" && (
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[13px]">
              <span className="mb-1.5 block font-medium">Rol</span>
              <select value={role} onChange={(e) => setRole(e.target.value)} className="field h-10 py-0">
                <option value="">Sin rol</option>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[13px]">
              <span className="mb-1.5 block font-medium">Carpeta</span>
              <select value={folderId} onChange={(e) => setFolderId(e.target.value)} className="field h-10 py-0">
                <option value="">Ninguna</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn h-9">
            Cancelar
          </button>
          <button type="submit" disabled={invalid || busy} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
            {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            Crear {invalid ? "" : n}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImportDialog({ kind, folders, onClose, onDone }: { kind: Kind; folders: FolderDto[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [folderId, setFolderId] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ rows: ImportRow[] }>("/wallets/import", { method: "POST", body: { text, folderId: folderId || null, kind } });
      setRows(r.rows);
      setText(""); // no dejar claves en memoria del formulario
      await onDone();
    } catch (err) {
      toast({ tone: "error", title: "No se pudo importar", body: (err as ApiError).message });
    }
    setBusy(false);
  };
  const ok = rows?.filter((r) => r.status === "imported").length ?? 0;
  return (
    <Modal title="Importar claves privadas" labelId="import-title" onClose={onClose} width={560}>
      {rows ? (
        <div className="mt-3">
          <p className="text-[13px]">
            <span className="text-buy">{ok} importadas</span>
            {rows.length - ok > 0 && <span className="text-muted"> · {rows.length - ok} con incidencias</span>}
          </p>
          <ul className="scroll-thin mt-3 max-h-[300px] space-y-1 overflow-y-auto">
            {rows.map((r) => (
              <li key={r.line} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface-2/50 px-3 py-1.5 text-[12px]">
                <span className="num w-12 text-faint">línea {r.line}</span>
                {r.status === "imported" ? <Check className="size-3.5 text-buy" aria-hidden /> : <X className={`size-3.5 ${r.status === "duplicate" ? "text-warn" : "text-sell"}`} aria-hidden />}
                <span className={r.status === "imported" ? "text-buy" : r.status === "duplicate" ? "text-warn" : "text-sell"}>{r.status === "imported" ? "importada" : r.status === "duplicate" ? "duplicada" : "inválida"}</span>
                <span className="num min-w-0 flex-1 truncate text-muted">{r.address ? `${r.address.slice(0, 6)}…${r.address.slice(-6)}` : r.reason}</span>
                {r.address && r.reason && <span className="text-faint">{r.reason}</span>}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setRows(null)} className="btn h-9">
              Importar más
            </button>
            <button onClick={onClose} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
              Listo
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-[13px] text-muted">Una clave por línea: base58 (formato Phantom), seed de 32 bytes o array JSON de solana-keygen. Las líneas con # se ignoran.</p>
          <textarea aria-label="Claves privadas, una por línea" value={text} onChange={(e) => setText(e.target.value)} rows={7} spellCheck={false} autoComplete="off" className="field num resize-none text-[12px] leading-relaxed" placeholder={"5Kd3…\n[12,34,…]"} />
          <div className="flex items-center gap-3">
            <label className="btn h-9 cursor-pointer">
              <Upload className="size-3.5" aria-hidden /> Desde archivo
              <input type="file" accept=".txt,.json,.csv" className="sr-only" onChange={async (e) => setText(await (e.target.files?.[0]?.text() ?? Promise.resolve("")))} />
            </label>
            {kind === "wallet" && (
              <select aria-label="Carpeta de destino" value={folderId} onChange={(e) => setFolderId(e.target.value)} className="field h-9 w-auto py-0 text-[12.5px]">
                <option value="">Sin carpeta</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
            <span className="num ml-auto text-[12px] text-faint">{lines} líneas</span>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn h-9">
              Cancelar
            </button>
            <button onClick={submit} disabled={lines === 0 || busy} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
              {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
              Importar {lines || ""}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RoleDialog({ roles, count, onClose, onPick }: { roles: string[]; count: number; onClose: () => void; onPick: (r: string | null) => void }) {
  const [custom, setCustom] = useState("");
  const invalid = custom !== "" && !ROLE_RE.test(custom);
  return (
    <Modal title={`Asignar rol a ${count}`} labelId="role-title" onClose={onClose} width={400}>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {roles.map((r) => (
          <button key={r} onClick={() => onPick(r)} className="btn h-8 text-[12.5px]">
            {r}
          </button>
        ))}
        <button onClick={() => onPick(null)} className="btn btn-ghost h-8 text-[12.5px]">
          Quitar rol
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (custom && !invalid) onPick(custom);
        }}
        className="mt-4"
      >
        <label htmlFor="custom-role" className="mb-1.5 block text-[13px] font-medium">
          Rol personalizado
        </label>
        <div className="flex gap-2">
          <input id="custom-role" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="sniper_1" aria-invalid={invalid} className="field num h-9" />
          <button type="submit" disabled={!custom || invalid} className="btn h-9">
            Asignar
          </button>
        </div>
        <p className={`mt-1.5 text-[11.5px] ${invalid ? "text-sell" : "text-faint"}`}>Minúsculas, dígitos y _, hasta 32 caracteres. Un rol asignado a mano nunca cambia solo.</p>
      </form>
    </Modal>
  );
}

function FolderDialog({ folders, count, onClose, onPick }: { folders: FolderDto[]; count: number; onClose: () => void; onPick: (id: string, op: "add" | "remove") => void }) {
  return (
    <Modal title={`Carpetas para ${count}`} labelId="folder-title" onClose={onClose} width={400}>
      {folders.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">Crea una carpeta en la columna izquierda primero.</p>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {folders.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface-2/50 px-3 py-2 text-[13px]">
              <FolderIcon className="size-3.5 text-muted" aria-hidden />
              <span className="flex-1">{f.name}</span>
              <button onClick={() => onPick(f.id, "add")} className="btn h-7 px-2 text-[12px]">
                Añadir
              </button>
              <button onClick={() => onPick(f.id, "remove")} className="btn btn-ghost h-7 px-2 text-[12px]">
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11.5px] text-faint">Una wallet puede estar en varias carpetas.</p>
    </Modal>
  );
}
