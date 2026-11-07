"use client";

// REQ-WAL-010: recuperar rent. Cierra las cuentas de token vacías de las wallets elegidas y manda el rent a
// una wallet propia, que paga la fee. Vista previa simulada → confirmar → resultado verificado en cadena.
import { useState } from "react";
import { CheckCircle2, CircleSlash, Loader2, PauseCircle, Recycle, XCircle } from "lucide-react";
import type { WalletDto } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { fmtLamports } from "@/lib/chain";
import { toast } from "@/lib/toast";
import { Modal } from "./dialogs";

type Item = { ord: number; walletId: string; label: string; accounts: number; rent: string; expected: string; fee: string; status: "PENDING" | "OK" | "FAILED" | "SKIPPED"; received: string | null; signature: string | null; reason: string | null };
type Reclaim = { id: string; status: "PREVIEW" | "RUNNING" | "PAUSED" | "COMPLETED" | "PARTIAL" | "FAILED"; to: { id: string; label: string | null }; items: Item[]; totals: { accounts: number; rent: string; fees: string; net: string } };

const L = (s: string) => fmtLamports(BigInt(s), 9);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ReclaimDialog({ owners, destinations, onClose, onDone }: { owners: WalletDto[]; destinations: WalletDto[]; onClose: () => void; onDone: () => void }) {
  const [toId, setToId] = useState(destinations.find((d) => d.isDefaultFunder)?.id ?? destinations[0]?.id ?? "");
  const [view, setView] = useState<Reclaim | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);

  const preview = async () => {
    setBusy("preview");
    try {
      setView(await api<Reclaim>("/reclaim/preview", { method: "POST", body: { walletIds: owners.map((o) => o.id), toId } }));
    } catch (e) {
      toast({ tone: "error", title: "No se pudo preparar", body: (e as ApiError).message });
    }
    setBusy(null);
  };

  const execute = async () => {
    if (!view) return;
    setBusy("run");
    try {
      let v = await api<Reclaim>(`/reclaim/${view.id}/execute`, { method: "POST", body: {} });
      for (let i = 0; i < 600 && v.status === "RUNNING"; i++) {
        await sleep(500);
        v = await api<Reclaim>(`/reclaim/${view.id}`);
      }
      setView(v);
      const got = v.items.reduce((a, i) => a + BigInt(i.received ?? "0"), 0n);
      toast({ tone: v.status === "COMPLETED" ? "buy" : v.status === "PAUSED" ? "warn" : "error", title: v.status === "PAUSED" ? "Recuperación en pausa" : `Rent recuperado · ${fmtLamports(got, 6)}`, body: v.status === "PAUSED" ? "Confirmación pendiente: reanúdala desde el aviso de pausa." : `En ${v.to.label}, verificado en cadena.` });
      onDone();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) setView(null);
      toast({ tone: "warn", title: "Revisa la recuperación", body: err.message });
    }
    setBusy(null);
  };

  const isPreview = view?.status === "PREVIEW";
  const pending = view?.items.filter((i) => i.status !== "SKIPPED") ?? [];
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Recycle className="size-4.5 text-accent-b" aria-hidden /> Recuperar rent de {owners.length} {owners.length === 1 ? "wallet" : "wallets"}
        </span>
      }
      labelId="reclaim-title"
      onClose={onClose}
      width={560}
    >
      {!view ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (toId) void preview();
          }}
        >
          <p className="text-[12.5px] text-muted">Cierra las cuentas de token con saldo 0 (las que quedan tras vender todo) y devuelve su rent, ~0,002 SOL cada una. Las cuentas con saldo no se tocan. Si vuelves a comprar ese token, la cuenta se crea de nuevo.</p>
          <label className="block text-[13px]">
            <span className="mb-1.5 block font-medium">Enviar el rent a</span>
            <select value={toId} onChange={(e) => setToId(e.target.value)} className="field h-10 py-0">
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                  {d.isDefaultFunder ? " · funder predeterminado" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[12px] text-faint">El destino paga la fee de red de cada transacción, así que necesita un poco de SOL; las wallets vacías también se pueden cerrar.</p>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn h-9">
              Cancelar
            </button>
            <button type="submit" disabled={!toId || !!busy} className="cta cta-fill flex h-9 items-center gap-2 px-4 text-[13px] font-semibold">
              {busy === "preview" && <Loader2 className="size-4 animate-spin" aria-hidden />} Ver vista previa
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3">
          <p className="text-[12.5px] text-muted">{isPreview ? `Simulado con el estado actual de la cadena. El neto llega a ${view.to.label} y ya descuenta la fee de red.` : "Verificado en cadena: lo recibido sale del saldo del destino antes y después, y las cuentas ya no existen."}</p>
          <ul className="mt-3 space-y-1.5">
            {view.items.map((i) => (
              <li key={i.ord} className="rounded-[var(--radius-sm)] border border-line bg-surface-2/50 px-3 py-2 text-[12.5px]">
                <div className="flex items-center gap-2">
                  {i.status === "OK" ? <CheckCircle2 className="size-3.5 text-buy" aria-label="cerradas" /> : i.status === "FAILED" ? <XCircle className="size-3.5 text-sell" aria-label="falló" /> : i.status === "SKIPPED" ? <CircleSlash className="size-3.5 text-faint" aria-label="omitida" /> : busy === "run" ? <Loader2 className="size-3.5 animate-spin text-muted" aria-label="enviando" /> : <PauseCircle className="size-3.5 text-muted" aria-label="pendiente" />}
                  <span className="flex-1">{i.label}</span>
                  {i.status === "SKIPPED" ? <span className="text-faint">{i.reason}</span> : <span className="num">{L(i.status === "OK" && i.received ? i.received : i.expected)}</span>}
                </div>
                {i.status !== "SKIPPED" && (
                  <p className="num mt-1 pl-5.5 text-[11.5px] text-faint">
                    {i.accounts} {i.accounts === 1 ? "cuenta" : "cuentas"} · {L(i.rent)} de rent − {L(i.fee)} de red
                    {i.status === "FAILED" && <span className="text-sell"> · {i.reason}</span>}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[13px]">
            <span className="text-muted">
              Neto a {view.to.label} ({view.totals.accounts} {view.totals.accounts === 1 ? "cuenta" : "cuentas"})
            </span>
            <span className="num text-[15px] font-medium">{L(view.totals.net)}</span>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onClose} disabled={busy === "run"} className="btn h-9 px-4 text-[13px]">
              {isPreview ? "Cancelar" : "Cerrar"}
            </button>
            {isPreview && (
              <button onClick={execute} disabled={!!busy || pending.length === 0} className="cta cta-fill flex h-9 items-center gap-2 px-4 text-[13px] font-semibold">
                {busy === "run" && <Loader2 className="size-4 animate-spin" aria-hidden />} Cerrar {view.totals.accounts} {view.totals.accounts === 1 ? "cuenta" : "cuentas"}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
