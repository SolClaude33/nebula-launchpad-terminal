"use client";

// REQ-VAULT-005: copia de seguridad de la bóveda (archivo cifrado, inútil sin la contraseña).
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

export function BackupsPanel() {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const blob = await api<Blob>("/vault/backup", { raw: true });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `nebula-${new Date().toISOString().slice(0, 10)}.nebula-vault`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast({ tone: "buy", title: "Copia exportada", body: "Guárdala fuera de este equipo. Se restaura desde /unlock con la misma contraseña." });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo exportar", body: (e as ApiError).message });
    }
    setBusy(false);
  };
  return (
    <section aria-labelledby="backup-t" className="panel reticle p-5">
      <p className="telemetry">Bóveda</p>
      <h2 id="backup-t" className="mt-0.5 text-[16px] font-semibold">
        Copia de seguridad
      </h2>
      <div className="mt-3 flex items-center justify-between gap-4">
        <p className="max-w-[560px] text-[12.5px] text-muted">Exporta la bóveda cifrada (wallets, ajustes e historial). Sin la contraseña maestra el archivo no sirve de nada. Se restaura desde la pantalla de desbloqueo.</p>
        <button onClick={download} disabled={busy} className="btn h-9 shrink-0 px-3 text-[12.5px]">
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />} Exportar copia
        </button>
      </div>
    </section>
  );
}
