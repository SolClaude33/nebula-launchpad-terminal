"use client";

// REQ-LOG-001: descarga el diagnóstico (estado, actividad y log técnico) con los secretos redactados en el servidor.
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

export function DiagnosticsButton({ className = "" }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const blob = await api<Blob>("/diagnostics", { raw: true });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `nebula-diagnostico-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast({ tone: "info", title: "Diagnóstico exportado", body: "Sin claves, contraseñas ni secretos de Ajustes. Revísalo antes de compartirlo." });
    } catch (e) {
      toast({ tone: "error", title: "No se pudo exportar", body: (e as ApiError).message });
    }
    setBusy(false);
  };
  return (
    <button onClick={run} disabled={busy} className={`btn h-9 px-3 text-[12.5px] ${className}`}>
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />} Exportar diagnóstico
    </button>
  );
}
