"use client";

import { useState } from "react";
import { FileUp, Loader2, TriangleAlert } from "lucide-react";
import type { VaultStatus } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { useVault } from "@/lib/vault";

/** REQ-VAULT-005: restaurar una copia. Sustituye la bóveda actual de este perfil. */
export function RestoreDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const setStatus = useVault((s) => s.set);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function restore(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !password) return;
    setBusy(true);
    setError("");
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const s = await api<VaultStatus>("/vault/restore", { method: "POST", body: { fileB64: btoa(bin), password } });
      setStatus(s);
      onDone();
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="restore-title" className="fixed inset-0 z-[95] grid place-items-center bg-black/60 backdrop-blur-sm" onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
      <form onSubmit={restore} className="glass rise w-[440px] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-float)]">
        <h3 id="restore-title" className="text-[16px] font-semibold">
          Restaurar copia de seguridad
        </h3>
        <p className="mt-1 text-[13px] text-muted">El archivo solo se abre con la contraseña con la que se creó.</p>
        <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-sm)] border border-warn/30 bg-[var(--warn-soft)] p-2.5 text-[12.5px] text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Sustituye la bóveda actual de este perfil. Si tiene wallets que no están en la copia, se perderán.
        </p>
        <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] border border-dashed border-line-strong bg-surface-1 p-3 text-[13px] hover:border-accent-b">
          <FileUp className="size-4 text-muted" aria-hidden />
          <span className="flex-1 truncate">{file ? file.name : "Elegir archivo .nebula-vault"}</span>
          <input type="file" accept=".nebula-vault,.sqlite,application/octet-stream" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label htmlFor="restore-pw" className="mt-3 mb-1.5 block text-[13px] font-medium">
          Contraseña de la copia
        </label>
        <input id="restore-pw" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="field h-10" />
        <p aria-live="polite" className="mt-2 min-h-5 text-[12.5px] text-sell">
          {error}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn h-9">
            Cancelar
          </button>
          <button type="submit" disabled={!file || !password || busy} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
            {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
            {busy ? "Restaurando…" : "Restaurar"}
          </button>
        </div>
      </form>
    </div>
  );
}
