"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PauseCircle, ServerCrash } from "lucide-react";
import { api } from "@/lib/api";
import { useVault } from "@/lib/vault";
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

/** REQ-VAULT-003 / REQ-AUTO-008: al desbloquear, se lista lo que se pausó y nada se reanuda solo. */
function PausedDialog({ status }: { status: VaultStatus }) {
  const set = useVault((s) => s.set);
  const ack = async () => set(await api<VaultStatus>("/vault/paused/ack", { method: "POST", body: {} }));
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="paused-title" className="fixed inset-0 z-[95] grid place-items-center bg-black/55 backdrop-blur-sm">
      <div className="glass rise w-[440px] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-float)]">
        <h3 id="paused-title" className="flex items-center gap-2 text-[16px] font-semibold">
          <PauseCircle className="size-5 text-warn" aria-hidden /> Esto quedó en pausa
        </h3>
        <p className="mt-1 text-[13px] text-muted">Se pausó al bloquear la bóveda o al reiniciar. Nada que mueva fondos se reanuda sin tu confirmación.</p>
        <ul className="mt-4 space-y-1.5">
          {status.paused.map((p) => (
            <li key={p.id} className="flex items-center justify-between rounded-[var(--radius-sm)] border border-line bg-surface-2/50 px-3 py-2 text-[13px]">
              <span>{p.label}</span>
              <span className="chip h-5 px-1.5 text-[10.5px]">{p.kind}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] text-faint">Podrás reanudar cada una desde Automatizaciones.</p>
        <div className="mt-5 flex justify-end">
          <button autoFocus onClick={ack} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
            Entendido, mantener en pausa
          </button>
        </div>
      </div>
    </div>
  );
}
