"use client";

// REQ-WAL-009: actividad de una wallet con datos locales (trades indexados, envíos propios y movimientos).
import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { fmtLamports } from "@/lib/chain";

type Act = {
  inNebulaSince: number;
  firstActivityAt: number | null;
  trades: number;
  tokens: number;
  buysLamports: number;
  sellsLamports: number;
  realizedLamports: number;
  padFeesLamports: number;
  networkFeesLamports: number;
  jitoLamports: number;
  rentLamports: number;
  transfersInLamports: number;
  transfersOutLamports: number;
  claimsLamports: number;
  reclaimedLamports: number;
  sends: number;
  open: { mint: string; tokens: number; costLamports: number }[];
};

const S = (l: number, signed = false) => `${signed && l > 0 ? "+" : ""}${fmtLamports(BigInt(Math.round(l)), 4)}`;
const day = (t: number) => new Date(t).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });

export function WalletActivity({ walletId }: { walletId: string }) {
  const [a, setA] = useState<Act | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<Act>(`/wallets/${walletId}/activity`).then(
      (r) => alive && (setA(r), setError(null)),
      (e) => alive && setError((e as ApiError).message),
    );
    return () => {
      alive = false;
    };
  }, [walletId]);

  const rows: [string, string, string?][] = a
    ? [
        ["En Nébula desde", day(a.inNebulaSince)],
        ["Primer movimiento", a.firstActivityAt ? day(a.firstActivityAt) : "—"],
        ["Trades · tokens", `${a.trades} · ${a.tokens}`],
        ["Compras", S(-a.buysLamports), "Incluyen las fees del pad"],
        ["Ventas", S(a.sellsLamports)],
        ["P&L realizado", S(a.realizedLamports, true), "Coste medio de lo que compró esta wallet; los tokens recibidos de otra wallet entran a coste 0"],
        ["Fees de red · Jito", `${S(-a.networkFeesLamports)} · ${S(-a.jitoLamports)}`, `En ${a.sends} envíos pagados por esta wallet`],
        ["Rent en cuentas", S(-a.rentLamports), "Recuperable cerrando las cuentas vacías"],
        ["Entradas · salidas", `${S(a.transfersInLamports)} · ${S(-a.transfersOutLamports)}`, "Movimientos de SOL hechos con Nébula"],
        ...(a.claimsLamports ? ([["Comisiones cobradas", S(a.claimsLamports)]] as [string, string][]) : []),
        ...(a.reclaimedLamports ? ([["Rent recuperado", S(a.reclaimedLamports)]] as [string, string][]) : []),
      ]
    : [];

  return (
    <div className="panel p-4">
      <p className="telemetry flex items-center gap-1.5">
        <Activity className="size-3.5" aria-hidden /> Actividad
      </p>
      {error ? (
        <p className="mt-2 text-[12px] text-sell">{error}</p>
      ) : !a ? (
        <div className="skeleton mt-3 h-40" aria-busy="true" />
      ) : (
        <>
          <dl className="mt-3 space-y-1.5 text-[12px]">
            {rows.map(([k, v, hint]) => (
              <div key={k} className="flex items-baseline justify-between gap-3" title={hint}>
                <dt className="text-muted">{k}</dt>
                <dd className={`num whitespace-nowrap text-right ${k === "P&L realizado" ? (a.realizedLamports > 0 ? "text-buy" : a.realizedLamports < 0 ? "text-sell" : "") : ""}`}>{v}</dd>
              </div>
            ))}
          </dl>
          {a.open.length > 0 && <p className="mt-2 text-[11.5px] text-faint">{a.open.length === 1 ? "1 posición abierta" : `${a.open.length} posiciones abiertas`} (coste {S(a.open.reduce((s, o) => s + o.costLamports, 0))}).</p>}
          <p className="mt-2 text-[11px] text-faint">Con lo que Nébula envió o indexó; lo hecho fuera de Nébula no aparece.</p>
        </>
      )}
    </div>
  );
}
