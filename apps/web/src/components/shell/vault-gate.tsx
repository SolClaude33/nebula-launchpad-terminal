"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, PauseCircle, Play, ServerCrash } from "lucide-react";
import { api } from "@/lib/api";
import { useVault } from "@/lib/vault";
import { useBalancesPolling } from "@/lib/chain";
import type { VaultStatus } from "@nebula/shared";

/** Protege el shell: sin bóveda → /setup; bloqueada → /unlock. Sondea el estado cada 5 s. */
export function VaultGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useVault((s) => s.status);
  const error = useVault((s) => s.error);
  const refresh = useVault((s) => s.refresh);
  const heartbeat = useVault((s) => s.heartbeat);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!status) return;
    if (!status.initialized) router.replace("/setup");
    else if (!status.unlocked) router.replace(`/unlock?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  useEffect(() => {
    const evs = ["pointerdown", "keydown", "wheel"] as const;
    evs.forEach((e) => window.addEventListener(e, heartbeat, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, heartbeat));
  }, [heartbeat]);

  if (error && !status) return <ApiDown message={error.message} />;
  if (!status?.unlocked) return <div className="skeleton m-6 h-[60vh]" aria-busy="true" aria-label="Comprobando la bóveda" />;
  return <Unlocked status={status}>{children}</Unlocked>;
}

function Unlocked({ status, children }: { status: VaultStatus; children: React.ReactNode }) {
  useBalancesPolling();
  return (
    <>
      {children}
      {status.paused.length > 0 && <PausedDialog status={status} />}
    </>
  );
}

function ApiDown({ message }: { message: string }) {
  return (
    <div className="mx-auto mt-24 max-w-md text-center">
      <ServerCrash className="mx-auto size-8 text-warn" aria-hidden />
      <h2 className="font-display mt-4 text-[28px] italic">API local sin respuesta</h2>
      <p className="mt-2 text-[13.5px] text-muted">{message}</p>
      <p className="mt-4 text-[12.5px] text-faint">
        Arranca todo con <span className="num text-muted">pnpm dev</span> en la raíz del proyecto.
      </p>
    </div>
  );
}

/** REQ-VAULT-003 / REQ-AUTO-008: al desbloquear, se lista lo que se pausó y cada cosa se reanuda solo si la confirmas. */
function PausedDialog({ status }: { status: VaultStatus }) {
  const set = useVault((s) => s.set);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const ack = async (ids?: string[]) => set(await api<VaultStatus>("/vault/paused/ack", { method: "POST", body: ids ? { ids } : {} }));
  const resume = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await api(`/operations/${id}/resume`, { method: "POST", body: {} });
      await ack([id]);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="paused-title" className="fixed inset-0 z-[95] grid place-items-center bg-black/55 backdrop-blur-sm">
      <div className="glass rise w-[480px] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-float)]">
        <h3 id="paused-title" className="flex items-center gap-2 text-[16px] font-semibold">
          <PauseCircle className="size-5 text-warn" aria-hidden /> Esto quedó en pausa
        </h3>
        <p className="mt-1 text-[13px] text-muted">Se pausó al bloquear la bóveda o al reiniciar. Nada que mueva fondos se reanuda sin tu confirmación; al reanudar no se repite lo que ya se envió.</p>
        <ul className="mt-4 space-y-1.5">
          {status.paused.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface-2/50 px-3 py-2 text-[13px]">
              <span className="flex-1">{p.label}</span>
              <span className="chip h-5 px-1.5 text-[10.5px]">{p.kind}</span>
              {p.kind === "operación" ? (
                <button onClick={() => resume(p.id)} disabled={!!busy} className="btn h-7 px-2.5 text-[12px]">
                  {busy === p.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                  Reanudar
                </button>
              ) : (
                <span className="text-[11.5px] text-faint">se reanuda desde su pantalla</span>
              )}
            </li>
          ))}
        </ul>
        {error && <p className="mt-2 text-[12.5px] text-sell">{error}</p>}
        <div className="mt-5 flex justify-end">
          <button autoFocus onClick={() => ack()} disabled={!!busy} className="btn h-9 px-4 text-[13px]">
            Mantener el resto en pausa
          </button>
        </div>
      </div>
    </div>
  );
}
