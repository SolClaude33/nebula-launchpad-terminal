"use client";

// REQ-LAUNCH-006: dirección de mint personalizada. Se genera en este equipo (hilos aparte del servidor local,
// cancelable) o se importa su clave; en los dos casos la clave va directa a la bóveda y queda ligada al borrador.
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Sparkles, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/lib/toast";

type Job = { prefix: string; suffix: string; ci: boolean; status: "RUNNING" | "FOUND" | "CANCELLED" | "FAILED"; attempts: number; expected: number; ratePerSec: number; elapsedSec: number; address: string | null; error: string | null };
type Status = { bound: string | null; job: Job | null; workers: number };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Medido el 2026-11-07: ~18.700 claves/s en un hilo suelto, ~11.300/s por hilo con 8 a la vez. Solo para la estimación previa. */
const PER_WORKER = 11_000;

const expected = (pattern: string, ci: boolean) => [...pattern].reduce((n, c) => n * (58 / Math.max(1, ci ? new Set([c.toLowerCase(), c.toUpperCase()].filter((v) => B58.includes(v))).size : 1)), 1);
const human = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toLocaleString("es-ES", { maximumFractionDigits: 1 })} h`);

export function VanityMint({ draftId }: { draftId: string }) {
  const [st, setSt] = useState<Status | null>(null);
  const [tab, setTab] = useState<"gen" | "import">("gen");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("pump");
  const [ci, setCi] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Status>(`/launches/${draftId}/vanity`).then(setSt, () => {});
  }, [draftId]);
  useEffect(load, [load]);
  const running = st?.job?.status === "RUNNING";
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 500);
    return () => clearInterval(id);
  }, [running, load]);

  const post = async (path: string, body: unknown = {}) => {
    setBusy(true);
    try {
      setSt(await api<Status>(`/launches/${draftId}/vanity/${path}`, { method: "POST", body }));
      return true;
    } catch (e) {
      toast({ tone: "warn", title: "Mint personalizado", body: (e as ApiError).message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pattern = prefix + suffix;
  const bad = [...pattern].find((c) => !(ci ? B58.includes(c.toLowerCase()) || B58.includes(c.toUpperCase()) : B58.includes(c)));
  const exp = expected(pattern, ci);
  const eta = exp / ((st?.workers ?? 4) * PER_WORKER);
  const job = st?.job;

  return (
    <fieldset className="rounded-[var(--radius-md)] border border-line bg-surface-1 p-4">
      <legend className="px-1 text-[13px] font-medium">Dirección del token (opcional)</legend>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
        <p>
          {st?.bound ? (
            <>
              Mint personalizado: <span className="num break-all text-accent-b">{st.bound}</span>
            </>
          ) : (
            <span className="text-muted">Aleatoria: se genera al preparar el lanzamiento.</span>
          )}
        </p>
        {st?.bound && (
          <button type="button" onClick={() => post("clear")} disabled={busy} className="btn h-7 px-2.5 text-[12px]">
            <X className="size-3.5" aria-hidden /> Usar una aleatoria
          </button>
        )}
      </div>

      <div role="tablist" aria-label="Cómo obtener el mint" className="mt-3 inline-flex gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
        {(
          [
            ["gen", "Generar"],
            ["import", "Importar clave"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`h-7 rounded-[6px] px-2.5 text-[12px] font-medium ${tab === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
            {l}
          </button>
        ))}
      </div>

      {tab === "gen" ? (
        <div className="mt-3 space-y-2.5">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[12.5px]">
              <span className="mb-1 block text-muted">Empieza por</span>
              <input value={prefix} onChange={(e) => setPrefix(e.target.value.trim())} maxLength={5} disabled={running} className="field num h-9 w-28" placeholder="—" />
            </label>
            <label className="text-[12.5px]">
              <span className="mb-1 block text-muted">Termina en</span>
              <input value={suffix} onChange={(e) => setSuffix(e.target.value.trim())} maxLength={5} disabled={running} className="field num h-9 w-28" placeholder="pump" />
            </label>
            <label className="mb-2 flex items-center gap-1.5 text-[12.5px]">
              <input type="checkbox" checked={ci} onChange={(e) => setCi(e.target.checked)} disabled={running} className="size-3.5 accent-[var(--accent-a)]" /> Sin distinguir mayúsculas
            </label>
            {running ? (
              <button type="button" onClick={() => post("cancel")} disabled={busy} className="btn h-9 px-3 text-[12.5px]">
                Cancelar
              </button>
            ) : (
              <button type="button" onClick={() => post("generate", { prefix, suffix, ci })} disabled={busy || !pattern || pattern.length > 5 || !!bad} className="cta cta-fill flex h-9 items-center gap-1.5 px-3.5 text-[12.5px] font-semibold">
                <Sparkles className="size-3.5" aria-hidden /> Buscar
              </button>
            )}
          </div>
          <p className={`text-[12px] ${bad || pattern.length > 5 ? "text-warn" : "text-faint"}`}>
            {bad ? `«${bad}» no existe en base58 (no se usan 0, O, I ni l).` : pattern.length > 5 ? "Como máximo 5 caracteres entre los dos: cada uno más multiplica el tiempo por ~58." : pattern ? `~${Math.round(exp).toLocaleString("es-ES")} intentos de media · unos ${human(eta)} con ${st?.workers ?? "…"} hilos de este equipo. Es probabilístico: puede tardar más o menos.` : "Pump.fun usa direcciones que terminan en «pump»; puedes pedir otro prefijo o sufijo."}
          </p>
          {job && (job.status === "RUNNING" || job.status === "FAILED") && (
            <div className="text-[12px]" aria-live="polite">
              {job.status === "RUNNING" ? (
                <>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Probabilidad acumulada de haberla encontrado" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((1 - Math.exp(-job.attempts / job.expected)) * 100)}>
                    <span className="block h-full bg-gradient-to-r from-accent-a to-accent-b transition-[width] duration-200" style={{ width: `${(1 - Math.exp(-job.attempts / job.expected)) * 100}%` }} />
                  </div>
                  <p className="num mt-1 flex items-center gap-1.5 text-muted">
                    <Loader2 className="size-3 animate-spin" aria-hidden /> {job.attempts.toLocaleString("es-ES")} intentos · {job.ratePerSec.toLocaleString("es-ES")}/s · {human(job.elapsedSec)}
                  </p>
                </>
              ) : (
                <p className="text-sell">La búsqueda falló: {job.error}</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await post("import", { secret })) setSecret("");
          }}
        >
          <label className="min-w-[280px] flex-1 text-[12.5px]">
            <span className="mb-1 block text-muted">Clave privada del mint (base58 o array JSON)</span>
            <input type="password" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} className="field num h-9 w-full" />
          </label>
          <button type="submit" disabled={busy || secret.length < 32} className="btn flex h-9 items-center gap-1.5 px-3 text-[12.5px]">
            <KeyRound className="size-3.5" aria-hidden /> Importar
          </button>
          <p className="w-full text-[12px] text-faint">Va directa a la bóveda cifrada. Se rechaza si el mint ya existe en la cadena o es una wallet tuya.</p>
        </form>
      )}
    </fieldset>
  );
}
