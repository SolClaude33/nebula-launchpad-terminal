"use client";

// REQ-VAULT-005 y §7.3: copia de seguridad de la bóveda (archivo cifrado, inútil sin la contraseña) y las
// copias automáticas diarias que la app guarda en su carpeta de datos (se conservan las 7 últimas).
import { useCallback, useEffect, useState } from "react";
import { Download, HardDriveDownload, Loader2, RefreshCw } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

type Backup = { name: string; at: number; bytes: number };

const save = (blob: Blob, name: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

export function BackupsPanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [items, setItems] = useState<Backup[] | null>(null);

  const load = useCallback(() => {
    api<{ items: Backup[] }>("/backups").then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, []);
  useEffect(load, [load]);

  const download = async () => {
    setBusy("export");
    try {
      save(await api<Blob>("/vault/backup", { raw: true }), `nebula-${new Date().toISOString().slice(0, 10)}.nebula-vault`);
      toast({ tone: "buy", title: "Copia exportada", body: "Guárdala fuera de este equipo. Se restaura desde /unlock con la misma contraseña." });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo exportar", body: (e as ApiError).message });
    }
    setBusy(null);
  };
  const runNow = async () => {
    setBusy("run");
    try {
      const r = await api<{ items: Backup[] }>("/backups/run", { method: "POST", body: {} });
      setItems(r.items);
      toast({ tone: "info", title: "Copia automática hecha", body: "Se conservan las 7 más recientes." });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo hacer la copia", body: (e as ApiError).message });
    }
    setBusy(null);
  };
  const get = async (b: Backup) => {
    setBusy(b.name);
    try {
      save(await api<Blob>(`/backups/${b.name}`, { raw: true }), `nebula-${b.name}`);
    } catch (e) {
      toast({ tone: "error", title: "No se pudo descargar", body: (e as ApiError).message });
    }
    setBusy(null);
  };

  return (
    <section aria-labelledby="backup-t" className="panel reticle p-5">
      <p className="telemetry">Bóveda</p>
      <h2 id="backup-t" className="mt-0.5 text-[16px] font-semibold">
        Copias de seguridad
      </h2>
      <div className="mt-3 flex items-center justify-between gap-4">
        <p className="max-w-[560px] text-[12.5px] text-muted">Exporta la bóveda cifrada (wallets, ajustes e historial). Sin la contraseña maestra el archivo no sirve de nada. Se restaura desde la pantalla de desbloqueo.</p>
        <button onClick={download} disabled={busy !== null} className="btn h-9 shrink-0 px-3 text-[12.5px]">
          {busy === "export" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />} Exportar copia
        </button>
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium">Copias automáticas diarias</p>
            <p className="text-[12px] text-muted">Una al día en la carpeta de datos de este equipo, con las 7 últimas. Descárgala para restaurarla.</p>
          </div>
          <button onClick={runNow} disabled={busy !== null} className="btn btn-ghost h-8 shrink-0 px-2.5 text-[12px]">
            {busy === "run" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />} Hacer una ahora
          </button>
        </div>
        {items === null ? (
          <div className="skeleton mt-3 h-16" aria-busy="true" />
        ) : items.length === 0 ? (
          <p className="mt-3 text-[12px] text-faint">Aún no hay copias automáticas: la primera se hace al arrancar la app.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-[var(--radius-sm)] border border-line">
            {items.map((b) => (
              <li key={b.name} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                <HardDriveDownload className="size-3.5 text-faint" aria-hidden />
                <span className="num flex-1">{new Date(b.at).toLocaleString("es-ES", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                <span className="num text-faint">{(b.bytes / 1024).toLocaleString("es-ES", { maximumFractionDigits: 0 })} KB</span>
                <button onClick={() => get(b)} disabled={busy !== null} className="btn btn-ghost h-7 px-2 text-[12px]" aria-label={`Descargar la copia del ${new Date(b.at).toLocaleString("es-ES")}`}>
                  {busy === b.name ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
