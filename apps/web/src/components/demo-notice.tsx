import { FlaskConical } from "lucide-react";

/** Aviso en las pantallas que aún usan datos simulados (Live Workspace y asistente). */
export function DemoNotice({ what }: { what: string }) {
  return (
    <div role="note" className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-warn/25 bg-[var(--warn-soft)] px-3 py-1.5 text-[12px] text-warn">
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">Datos simulados.</strong> {what} usa un motor de demostración hasta conectar el adaptador de Pump.fun; no se firma ni se envía nada.
      </span>
    </div>
  );
}
