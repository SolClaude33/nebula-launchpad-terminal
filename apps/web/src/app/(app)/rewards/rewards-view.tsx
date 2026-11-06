"use client";

// REQ-REW-001/002: comisiones de creador reclamables en Pump.fun y PumpSwap.
// La bóveda de comisiones es por wallet creadora (no por token): la lista es por wallet y muestra,
// como contexto, los tokens que esa wallet lanzó desde Nébula.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleSlash, Coins, Loader2, PauseCircle, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Address } from "@/components/address";
import { fmtSol, fmtUsd } from "@/lib/format";
import { lamToSol } from "@/lib/live";
import { toast } from "@/lib/toast";

type ScanItem = { walletId: string; label: string; address: string; role: string | null; claimable: string; fee: string; net: string; lamports: string; canPayFee: boolean; tokens: { mint: string; symbol: string }[] };
type Scan = { items: ScanItem[]; solUsd: { usd: number; publishedAt: number } | null; at: number };
type ClaimItem = { ord: number; walletId: string; label: string; address: string; expected: string; fee: string; networkFee: string; status: "PENDING" | "OK" | "FAILED" | "SKIPPED"; received: string | null; leftAfter: string | null; signature: string | null; reason: string | null };
type Claim = { id: string; status: "PREVIEW" | "RUNNING" | "PAUSED" | "COMPLETED" | "PARTIAL" | "FAILED"; items: ClaimItem[]; totals: { gross: string; fees: string; net: string } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function RewardsView() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [claim, setClaim] = useState<Claim | null>(null);
  const [busy, setBusy] = useState<"preview" | "claim" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api<Scan>("/rewards");
      setScan(s);
      setError(null);
      setSel((prev) => new Set([...prev].filter((id) => s.items.some((i) => i.walletId === id && BigInt(i.claimable) > 0n))));
    } catch (e) {
      setError((e as ApiError).message);
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    let alive = true;
    api<Scan>("/rewards").then(
      (s) => alive && setScan(s),
      (e) => alive && setError((e as ApiError).message),
    );
    return () => {
      alive = false;
    };
  }, []);

  const usd = scan?.solUsd?.usd ?? null;
  const money = (l: string | number) => (
    <>
      <span className="num">{fmtSol(lamToSol(l), 6)}</span>
      {usd && <span className="num ml-1.5 text-[11.5px] text-faint">{fmtUsd(lamToSol(l) * usd, false)}</span>}
    </>
  );
  const claimable = (scan?.items ?? []).filter((i) => BigInt(i.claimable) > 0n);
  const total = claimable.reduce((a, i) => a + BigInt(i.claimable), 0n);
  const toggle = (id: string) => setSel((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  const preview = async (ids: string[]) => {
    setBusy("preview");
    try {
      setClaim(await api<Claim>("/rewards/preview", { method: "POST", body: { walletIds: ids } }));
    } catch (e) {
      toast({ tone: "error", title: "No se pudo preparar el reclamo", body: (e as ApiError).message });
    }
    setBusy(null);
  };

  const execute = async () => {
    if (!claim) return;
    setBusy("claim");
    try {
      let v = await api<Claim>(`/rewards/${claim.id}/execute`, { method: "POST", body: {} });
      for (let i = 0; i < 600 && v.status === "RUNNING"; i++) {
        await sleep(500);
        v = await api<Claim>(`/rewards/${claim.id}`);
      }
      setClaim(v);
      const ok = v.items.filter((i) => i.status === "OK");
      const got = ok.reduce((a, i) => a + BigInt(i.received ?? "0"), 0n);
      toast({ tone: v.status === "COMPLETED" ? "buy" : v.status === "PAUSED" ? "warn" : "error", title: v.status === "PAUSED" ? "Reclamo en pausa" : `Comisiones cobradas · ${ok.length} wallets`, body: v.status === "PAUSED" ? "Confirmación pendiente: reanúdalo desde el aviso de pausa." : `Recibido ${fmtSol(lamToSol(got), 6)} (verificado en cadena).` });
      void load();
    } catch (e) {
      const err = e as ApiError;
      // Si lo reclamable cambió, el servidor actualiza la vista previa y pide confirmar de nuevo
      if (err.status === 409) setClaim(await api<Claim>(`/rewards/${claim.id}`));
      toast({ tone: "warn", title: "Revisa el reclamo", body: err.message });
    }
    setBusy(null);
  };

  return (
    <div className="mx-auto max-w-[980px] p-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="telemetry">Fondos</p>
          <h1 className="font-display mt-1 text-[30px] tracking-[-0.01em]">Comisiones de creador</h1>
          <p className="mt-1 text-[13px] text-muted">Lo que Pump.fun y PumpSwap han acumulado para tus wallets creadoras. La bóveda es por wallet, no por token.</p>
        </div>
        <button onClick={load} disabled={loading} className="btn h-9 px-3 text-[12.5px]">
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden /> Escanear
        </button>
      </div>

      <div className="panel reticle mt-5 flex items-center gap-6 p-5">
        <Coins className="size-6 text-accent" aria-hidden />
        <div>
          <p className="telemetry">Reclamable ahora</p>
          <p className="mt-0.5 text-[24px] font-medium tracking-[-0.01em]">{scan ? money(total.toString()) : "—"}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={() => preview([...sel])} disabled={sel.size === 0 || !!busy} className="btn h-10 px-4 text-[13px]">
            Reclamar selección ({sel.size})
          </button>
          <button onClick={() => preview(claimable.map((i) => i.walletId))} disabled={claimable.length === 0 || !!busy} className="cta cta-fill flex h-10 items-center gap-2 px-4 text-[13px] font-semibold">
            {busy === "preview" && <Loader2 className="size-4 animate-spin" aria-hidden />} Reclamar todo
          </button>
        </div>
      </div>

      {error && <p className="mt-4 rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-3 text-[12.5px] text-sell">{error}</p>}

      {scan === null && !error ? (
        <div className="skeleton mt-4 h-40" aria-busy="true" />
      ) : scan && scan.items.length === 0 ? (
        <div className="panel mt-4 p-6 text-center text-[13px] text-muted">
          Ninguna wallet propia tiene comisiones ni ha lanzado tokens todavía.{" "}
          <Link href="/launch/new" className="text-accent-b hover:underline">
            Lanzar un token
          </Link>
        </div>
      ) : (
        scan && (
          <table className="panel mt-4 w-full overflow-hidden text-[12.5px]">
            <thead>
              <tr className="text-left">
                <th className="telemetry w-10 px-3 py-2 font-normal">
                  <span className="sr-only">Seleccionar</span>
                </th>
                <th className="telemetry px-3 py-2 font-normal">Wallet</th>
                <th className="telemetry px-3 py-2 font-normal">Tokens lanzados</th>
                <th className="telemetry px-3 py-2 text-right font-normal">Reclamable</th>
                <th className="telemetry px-3 py-2 text-right font-normal">SOL para la fee</th>
              </tr>
            </thead>
            <tbody>
              {scan.items.map((i) => {
                const has = BigInt(i.claimable) > 0n;
                return (
                  <tr key={i.walletId} className="border-t border-line/60">
                    <td className="px-3 py-2.5">
                      <input type="checkbox" aria-label={`Seleccionar ${i.label}`} disabled={!has} checked={sel.has(i.walletId)} onChange={() => toggle(i.walletId)} className="size-3.5 accent-[var(--accent-a)]" />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col">
                        <span>{i.label}</span>
                        <Address value={i.address} className="text-[11px] text-faint" />
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {i.tokens.length === 0 ? (
                          <span className="text-faint">—</span>
                        ) : (
                          i.tokens.map((t) => (
                            <Link key={t.mint} href={`/t/${t.mint}`} className="chip h-5 px-1.5 text-[10.5px] hover:border-accent/40">
                              ${t.symbol}
                            </Link>
                          ))
                        )}
                      </div>
                    </td>
                    <td className={`px-3 py-2.5 text-right ${has ? "" : "text-faint"}`}>{money(i.claimable)}</td>
                    <td className={`num px-3 py-2.5 text-right ${i.canPayFee ? "text-muted" : "text-warn"}`} title={i.canPayFee ? "" : "Sin SOL para la fee de red: recarga la wallet antes de reclamar"}>
                      {fmtSol(lamToSol(i.lamports), 4)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}

      {claim && <ClaimDialog claim={claim} busy={busy === "claim"} onConfirm={execute} onClose={() => setClaim(null)} money={money} />}
    </div>
  );
}

/** REQ-REW-002: pantalla de confirmación con el neto después de la fee de red y del rent de cuentas nuevas. */
function ClaimDialog({ claim, busy, onConfirm, onClose, money }: { claim: Claim; busy: boolean; onConfirm: () => void; onClose: () => void; money: (l: string | number) => React.ReactNode }) {
  const preview = claim.status === "PREVIEW";
  const pending = claim.items.filter((i) => i.status !== "SKIPPED");
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="claim-title" className="fixed inset-0 z-[90] grid place-items-center bg-black/55 backdrop-blur-sm">
      <div className="glass rise w-[560px] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-float)]">
        <h3 id="claim-title" className="flex items-center gap-2 text-[16px] font-semibold">
          <ShieldCheck className="size-5 text-accent" aria-hidden /> {preview ? "Confirmar reclamo" : "Resultado del reclamo"}
        </h3>
        <p className="mt-1 text-[12.5px] text-muted">{preview ? "Simulado con el estado actual de la cadena: el neto ya descuenta la fee de red y el rent de las cuentas que el reclamo tenga que crear." : "Verificado en cadena: lo recibido sale del saldo antes y después, y lo reclamable debe quedar en 0."}</p>
        <ul className="mt-4 space-y-1.5">
          {claim.items.map((i) => {
            const net = BigInt(i.expected) - BigInt(i.fee);
            const extra = BigInt(i.fee) - BigInt(i.networkFee);
            return (
              <li key={i.ord} className="rounded-[var(--radius-sm)] border border-line bg-surface-2/50 px-3 py-2 text-[12.5px]">
                <div className="flex items-center gap-2">
                  {i.status === "OK" ? <CheckCircle2 className="size-3.5 text-buy" aria-label="cobrada" /> : i.status === "FAILED" ? <XCircle className="size-3.5 text-sell" aria-label="falló" /> : i.status === "SKIPPED" ? <CircleSlash className="size-3.5 text-faint" aria-label="omitida" /> : busy ? <Loader2 className="size-3.5 animate-spin text-muted" aria-label="enviando" /> : <PauseCircle className="size-3.5 text-muted" aria-label="pendiente" />}
                  <span className="flex-1">{i.label}</span>
                  {i.status === "SKIPPED" ? <span className="text-faint">{i.reason}</span> : <span>{money(i.status === "OK" && i.received ? i.received : net.toString())}</span>}
                </div>
                {i.status !== "SKIPPED" && (
                  <p className="num mt-1 pl-5.5 text-[11.5px] text-faint">
                    {fmtSol(lamToSol(i.expected), 6)} reclamable − {fmtSol(lamToSol(i.networkFee), 6)} de red{extra > 0n ? ` − ${fmtSol(lamToSol(extra), 6)} de cuentas nuevas` : ""}
                    {i.status === "OK" && i.leftAfter !== null && <span className={i.leftAfter === "0" ? "text-buy" : "text-warn"}> · {i.leftAfter === "0" ? "bóveda vacía ✓" : `quedan ${fmtSol(lamToSol(i.leftAfter), 6)}`}</span>}
                    {i.status === "FAILED" && <span className="text-sell"> · {i.reason}</span>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[13px]">
          <span className="text-muted">Neto total ({pending.length} wallets)</span>
          <span className="text-[15px] font-medium">{money(claim.totals.net)}</span>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="btn h-9 px-4 text-[13px]">
            {preview ? "Cancelar" : "Cerrar"}
          </button>
          {preview && (
            <button onClick={onConfirm} disabled={busy || pending.length === 0} className="cta cta-fill flex h-9 items-center gap-2 px-4 text-[13px] font-semibold">
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />} Reclamar {pending.length} wallets
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
