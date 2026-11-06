"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, ArrowRight, Rocket } from "lucide-react";
import { api } from "@/lib/api";
import { Address } from "@/components/address";
import { TokenGlyph } from "@/components/live/token-header";
import { timeAgo } from "@/lib/format";

type Launch = { id: string; status: string; mint: string; name: string; symbol: string; mode: string; createdAt: number };
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Abre el Live Workspace de un token: uno lanzado con Nébula o cualquier coin de Pump.fun por su mint. */
export function TokenPicker() {
  const router = useRouter();
  const [mint, setMint] = useState("");
  const [launches, setLaunches] = useState<Launch[] | null>(null);
  useEffect(() => {
    api<{ items: Launch[] }>("/launches")
      .then((r) => setLaunches(r.items))
      .catch(() => setLaunches([]));
  }, []);
  const value = mint.trim();
  const invalid = value.length > 0 && !B58.test(value);
  const open = (e: React.FormEvent) => {
    e.preventDefault();
    if (B58.test(value)) router.push(`/t/${value}`);
  };

  return (
    <div className="mx-auto max-w-[720px] p-6">
      <p className="telemetry">Live Workspace</p>
      <h1 className="font-display mt-1 text-[30px] tracking-[-0.01em]">Abrir un token</h1>
      <p className="mt-1 text-[13px] text-muted">Curva, trades en vivo, holders y tu posición, leídos de la cadena. Funciona con cualquier coin de Pump.fun, en la curva o ya en PumpSwap.</p>

      <form onSubmit={open} className="panel reticle mt-5 flex items-end gap-2 p-4">
        <div className="flex-1">
          <label htmlFor="mint" className="mb-1.5 block text-[12px] text-muted">
            Dirección del token (mint)
          </label>
          <input id="mint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="p. ej. 7xKX…pump" autoComplete="off" spellCheck={false} aria-invalid={invalid} aria-describedby="mint-err" className="field num h-10" />
          <p id="mint-err" className="mt-1 min-h-4 text-[11.5px] text-sell">
            {invalid ? "No parece una dirección de Solana (base58, 32 a 44 caracteres)." : ""}
          </p>
        </div>
        <button type="submit" disabled={!B58.test(value)} className="btn mb-5 h-10 px-4 text-[13px]">
          Abrir <ArrowRight className="size-4" aria-hidden />
        </button>
      </form>

      <h2 className="mt-7 mb-2 text-[13px] font-medium">Lanzados con Nébula</h2>
      {launches === null ? (
        <div className="skeleton h-20" aria-busy="true" />
      ) : launches.length === 0 ? (
        <div className="panel flex items-center gap-3 p-4 text-[13px] text-muted">
          <Rocket className="size-4 text-accent" aria-hidden />
          Aún no has lanzado ningún token.
          <Link href="/launch/new" className="ml-auto text-accent-b hover:underline">
            Lanzar el primero
          </Link>
        </div>
      ) : (
        <ul className="panel divide-y divide-line">
          {launches.map((l) => (
            <li key={l.id} className="flex items-center gap-3 px-4 py-3">
              <TokenGlyph symbol={l.symbol} size={34} />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium">
                  {l.name} <span className="num text-[12px] text-muted">${l.symbol}</span>
                </p>
                <p className="text-[12px] text-muted">
                  <Address value={l.mint} kind="token" /> · hace {timeAgo(l.createdAt)}
                  {l.status !== "DONE" && <span className="chip ml-2 h-5 px-1.5 text-[10.5px]">{l.status === "PAUSED" ? "en pausa" : "en curso"}</span>}
                </p>
              </div>
              <Link href={`/t/${l.mint}`} className="btn h-8 px-3 text-[12px]">
                <Activity className="size-3.5" aria-hidden /> Live
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
