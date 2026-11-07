"use client";

// Resto «Should» de F1: recuperar el rent de la tabla de direcciones de lanzamiento. Dos pasos que impone Solana:
// desactivar y, ~512 slots después (unos 3–4 min), cerrar. Solo compensa si ya no vas a lanzar más: el siguiente
// lanzamiento la vuelve a crear y paga el rent otra vez.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Table2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { fmtLamports } from "@/lib/chain";
import { toast } from "@/lib/toast";

type Own = { id: string; label: string; address: string } | null;
type Alt = { address: string; authority: string | null; lamports: string; authorityWallet: Own };
type Info = { current: Alt | null; closing: (Alt & { deactivationSlot: number; slotsLeft: number }) | null; blocker: string | null };
type Wallet = { id: string; label: string; kind: string; isDefaultFunder: boolean };

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function AltPanel() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"deactivate" | "close" | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [to, setTo] = useState("");
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(() => {
    api<Info>("/launches/alt").then(
      (r) => (setInfo(r), setError(null)),
      (e) => setError((e as ApiError).message),
    );
  }, []);
  useEffect(() => {
    load();
    api<{ wallets: Wallet[] }>("/wallets").then(
      (r) => {
        setWallets(r.wallets);
        setTo((t) => t || (r.wallets.find((w) => w.isDefaultFunder)?.id ?? r.wallets[0]?.id ?? ""));
      },
      () => {},
    );
  }, [load]);
  // Mientras se enfría, se refresca la cuenta atrás
  useEffect(() => {
    if (!info?.closing || info.closing.slotsLeft === 0) return;
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [info, load]);

  const act = async (kind: "deactivate" | "close") => {
    setBusy(kind);
    try {
      const r = await api<Info & { recovered?: string; to?: string }>(`/launches/alt/${kind}`, { method: "POST", body: kind === "close" ? { recipientId: to } : {} });
      setInfo(r);
      setConfirm(false);
      toast(kind === "close" ? { tone: "buy", title: "Tabla cerrada", body: `${fmtLamports(BigInt(r.recovered ?? "0"), 6)} de rent a ${r.to}.` } : { tone: "info", title: "Tabla desactivada", body: "Se podrá cerrar en unos 3–4 minutos." });
    } catch (e) {
      toast({ tone: "warn", title: kind === "close" ? "No se pudo cerrar" : "No se pudo desactivar", body: (e as ApiError).message });
      load();
    }
    setBusy(null);
  };

  return (
    <section aria-labelledby="alt-t" className="panel reticle p-5">
      <p className="telemetry">Lanzamientos</p>
      <h2 id="alt-t" className="mt-0.5 flex items-center gap-2 text-[16px] font-semibold">
        <Table2 className="size-4 text-accent-b" aria-hidden /> Tabla de direcciones
      </h2>
      <p className="mt-2 max-w-[640px] text-[12.5px] text-muted">Nébula usa una tabla propia para que la creación con dev buy quepa en una transacción. Cerrarla devuelve su rent, pero solo compensa si ya no vas a lanzar más: el siguiente lanzamiento la vuelve a crear y paga el rent de nuevo.</p>
      {error && <p className="mt-3 text-[12.5px] text-sell">{error}</p>}
      {!info ? (
        !error && <div className="skeleton mt-4 h-16" aria-busy="true" />
      ) : info.closing ? (
        <div className="mt-4 rounded-[var(--radius-sm)] border border-line bg-surface-2/50 p-3 text-[12.5px]">
          <p>
            Tabla <span className="num">{short(info.closing.address)}</span> desactivada · rent <span className="num">{fmtLamports(BigInt(info.closing.lamports), 6)}</span>
          </p>
          {info.closing.slotsLeft > 0 ? (
            <p className="mt-1 text-muted" aria-live="polite">
              Se podrá cerrar en ~{info.closing.slotsLeft} slots (unos {Math.max(1, Math.ceil((info.closing.slotsLeft * 0.4) / 60))} min).
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-[12.5px]">
                <span className="mb-1 block text-muted">Enviar el rent a</span>
                <select value={to} onChange={(e) => setTo(e.target.value)} className="field h-9 py-0">
                  {wallets.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label}
                      {w.isDefaultFunder ? " · funder predeterminado" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => act("close")} disabled={!to || busy !== null} className="cta cta-fill flex h-9 items-center gap-2 px-4 text-[13px] font-semibold">
                {busy === "close" && <Loader2 className="size-4 animate-spin" aria-hidden />} Cerrar y recuperar
              </button>
            </div>
          )}
          {!info.closing.authorityWallet && <p className="mt-2 text-warn">La autoridad de la tabla no está en la bóveda: no se puede firmar el cierre.</p>}
        </div>
      ) : info.current ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-line bg-surface-2/50 p-3 text-[12.5px]">
          <p>
            Tabla <span className="num">{short(info.current.address)}</span> activa · rent <span className="num">{fmtLamports(BigInt(info.current.lamports), 6)}</span> · autoridad {info.current.authorityWallet?.label ?? "fuera de la bóveda"}
          </p>
          {confirm ? (
            <div className="flex items-center gap-2">
              <span className="text-warn">¿Seguro? El próximo lanzamiento pagará otra tabla.</span>
              <button onClick={() => setConfirm(false)} className="btn h-8 px-3 text-[12px]">
                No
              </button>
              <button onClick={() => act("deactivate")} disabled={busy !== null} className="btn h-8 border-warn/40 px-3 text-[12px] text-warn">
                {busy === "deactivate" && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Desactivar
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirm(true)} disabled={!!info.blocker || !info.current.authorityWallet} title={info.blocker ?? undefined} className="btn h-8 px-3 text-[12px]">
              Desactivar para recuperar el rent
            </button>
          )}
          {info.blocker && <p className="w-full text-[12px] text-faint">{info.blocker}</p>}
        </div>
      ) : (
        <p className="mt-4 text-[12.5px] text-faint">No hay tabla: se crea al preparar el primer lanzamiento.</p>
      )}
    </section>
  );
}
