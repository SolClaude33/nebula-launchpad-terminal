"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Info, Loader2 } from "lucide-react";
import { lamToSol, useLive } from "@/lib/live";
import { runOrder, useTradeQuote, useWalletPicker, type Side } from "@/lib/trade";
import { fmtSol } from "@/lib/format";

const toLamports = (v: string) => {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e9)) : 0n;
};

export function TradeTicket() {
  const [side, setSide] = useState<Side>("buy");
  const { folders, scope, setScope, includeDev, setIncludeDev, hasDev, selected, pickedCount } = useWalletPicker("nebula.ticket.scope");
  const venue = useLive((s) => s.info?.venue ?? "curve");
  const [amount, setAmount] = useState("0,1");
  const [pct, setPct] = useState(25);
  const [slippage, setSlippage] = useState({ buy: "15", sell: "5" });
  const [mode, setMode] = useState<"parallel" | "staggered">("parallel");
  const [busy, setBusy] = useState(false);

  const buy = side === "buy";
  const lamports = toLamports(amount);
  const slip = Number(slippage[side].replace(",", ".")) || 0;
  const holding = selected.filter((w) => w.tokens > 0n);
  const targets = buy ? selected : holding;
  const slipError = slip < 0.1 || slip > 50 ? "Entre 0,1 % y 50 %." : null;
  const { quote, error: quoteError } = useTradeQuote(targets.length && !slipError && (!buy || lamports > 0n) ? { side, walletIds: targets.map((w) => w.id), ...(buy ? { lamportsEach: lamports.toString() } : { pct }), slippagePct: slip } : null);
  const max = quote ? BigInt(quote.maxBuyPerWallet) : null;
  const okCount = quote ? quote.items.filter((i) => i.ok).length : targets.length;

  const amountError = buy && lamports <= 0n ? "Indica un monto mayor que 0." : buy && max !== null && lamports > max ? `Supera el máximo por wallet (${fmtSol(lamToSol(max), 4)}).` : null;
  const emptySel = targets.length === 0 ? (buy ? "No hay wallets en la selección." : "Ninguna wallet seleccionada tiene tokens.") : null;
  const migrating = venue === "migrating" ? "La curva está completa y la migración a PumpSwap aún no ha ocurrido." : null;
  const disabledReason = migrating ?? emptySel ?? amountError ?? slipError ?? (quote && okCount === 0 ? quote.items[0]?.reason ?? "Ninguna wallet puede operar." : null);

  async function submit() {
    if (disabledReason) return;
    setBusy(true);
    await runOrder({ side, walletIds: targets.map((w) => w.id), ...(buy ? { lamportsEach: lamports.toString() } : { pct }), slippagePct: slip, mode }, "ticket");
    setBusy(false);
  }

  const c = quote?.costs;
  const skipped = quote?.items.filter((i) => !i.ok) ?? [];

  return (
    <section aria-label="Ticket de compra y venta" className="panel reticle flex flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="telemetry">02 · Ticket</p>
        <span className="chip h-5 px-2 text-[10.5px]">{venue === "pumpswap" ? "PumpSwap" : venue === "migrating" ? "migrando" : "bonding curve"}</span>
      </div>

      <div role="radiogroup" aria-label="Lado" className="grid grid-cols-2 gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={side === s}
            onClick={() => setSide(s)}
            className={`flex h-9 items-center justify-center gap-1.5 rounded-[6px] text-[13px] font-medium transition-colors ${
              side === s ? (s === "buy" ? "bg-[var(--buy-soft)] text-buy" : "bg-[var(--sell-soft)] text-sell") : "text-muted hover:text-fg"
            }`}
          >
            {s === "buy" ? <ArrowUpRight className="size-4" aria-hidden /> : <ArrowDownRight className="size-4" aria-hidden />}
            {s === "buy" ? "Comprar" : "Vender"}
          </button>
        ))}
      </div>

      <label className="mt-4 mb-1.5 block text-[12px] text-muted" htmlFor="ticket-scope">
        Wallets
      </label>
      <div className="flex gap-2">
        <select id="ticket-scope" value={scope} onChange={(e) => setScope(e.target.value)} className="field h-9 py-0">
          <option value="all">Todas las wallets</option>
          <option value="picked">Marcadas en «Mis wallets» ({pickedCount})</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              Carpeta · {f.name}
            </option>
          ))}
        </select>
        <span className="chip num h-9 shrink-0 rounded-[var(--radius-sm)] px-3">{targets.length} sel.</span>
      </div>
      {hasDev && (
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
          <input type="checkbox" checked={includeDev} onChange={(e) => setIncludeDev(e.target.checked)} className="size-3.5 accent-[var(--accent-a)]" />
          Incluir wallet dev {includeDev && <span className="chip h-5 border-warn/30 px-1.5 text-[10.5px] text-warn">incl. dev</span>}
        </label>
      )}

      {buy ? (
        <>
          <label className="mt-4 mb-1.5 flex justify-between text-[12px] text-muted" htmlFor="ticket-amount">
            SOL por wallet <span className="num text-faint">máx. {max === null ? "—" : fmtSol(lamToSol(max), 4)}</span>
          </label>
          <div className="relative">
            <input id="ticket-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!amountError} aria-describedby="ticket-amount-err" className="field num h-10 pr-14 text-[15px]" />
            <span className="num pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12px] text-faint">SOL</span>
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            {["0,05", "0,1", "0,25", "0,5"].map((v) => (
              <button key={v} onClick={() => setAmount(v)} className={`btn num h-8 px-0 text-[12px] ${amount === v ? "border-accent/40 text-fg" : ""}`}>
                {v}
              </button>
            ))}
            <button onClick={() => max !== null && setAmount((Math.floor(lamToSol(max) * 1e6) / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 6 }))} disabled={max === null || max <= 0n} className="btn h-8 px-0 text-[11.5px]" title="Reserva fees, rent de las cuentas nuevas y un margen">
              MAX
            </button>
          </div>
          {amountError && (
            <p id="ticket-amount-err" className="mt-1.5 text-[12px] text-sell">
              {amountError}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mt-4 mb-1.5 text-[12px] text-muted">Porcentaje de la posición de cada wallet</p>
          <div className="grid grid-cols-4 gap-1.5">
            {[25, 50, 75, 100].map((v) => (
              <button key={v} onClick={() => setPct(v)} aria-pressed={pct === v} className={`btn num h-9 ${pct === v ? "border-sell/40 bg-[var(--sell-soft)] text-sell" : ""}`}>
                {v} %
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="ticket-slip" className="mb-1.5 block text-[12px] text-muted">
            Slippage máx.
          </label>
          <div className="relative">
            <input id="ticket-slip" inputMode="decimal" value={slippage[side]} onChange={(e) => setSlippage((s) => ({ ...s, [side]: e.target.value }))} aria-invalid={!!slipError} className="field num h-9 pr-8" />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12px] text-faint">%</span>
          </div>
        </div>
        <div>
          <span className="mb-1.5 block text-[12px] text-muted">Ejecución</span>
          <div role="radiogroup" aria-label="Ejecución" className="grid h-9 grid-cols-2 gap-0.5 rounded-[var(--radius-sm)] border border-line bg-surface-2 p-0.5">
            {(["parallel", "staggered"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} title={m === "staggered" ? "Una wallet tras otra con un retardo fijo" : "Todas a la vez"} className={`rounded-[6px] text-[11.5px] ${mode === m ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
                {m === "parallel" ? "Paralelo" : "Escalonado"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-[var(--radius-sm)] border border-line bg-surface-2/40 p-3 text-[12px]" aria-busy={!quote && !quoteError}>
      <dl className="space-y-1.5">
        <Row label={buy ? `Compras (${okCount} × ${fmtSol(lamToSol(lamports), 3)})` : `Recibes aprox. (${okCount} wallets)`} value={c ? fmtSol(lamToSol(c.volume), 4) : "—"} strong />
        <Row label="Fee de red" value={c ? fmtSol(lamToSol(c.network), 6) : "—"} />
        <Row label="Priority fee" value={c ? fmtSol(lamToSol(c.priority), 5) : "—"} />
        {c && BigInt(c.rent) > 0n && <Row label="Rent de cuentas nuevas" value={fmtSol(lamToSol(c.rent), 5)} hint="Cuenta de token y cuentas del programa que crea la primera compra. La de token se recupera al cerrarla vacía." />}
        <Row label={`Fee del pad${quote ? ` (${(quote.padFeeBps / 100).toLocaleString("es-ES")} %)` : ""}`} value={c ? fmtSol(lamToSol(c.padFee), 5) : "—"} hint="La informa el adaptador con las fees reales del programa; ya va incluida en el precio." />
      </dl>
      <dl className="mt-2.5 border-t border-line pt-2.5">
        <Row label={buy ? "Total a gastar" : "Coste de la operación"} value={c ? fmtSol(lamToSol(c.total), 4) : "—"} strong />
      </dl>
        {skipped.length > 0 && <p className="pt-1 text-[11.5px] text-warn">{skipped.length === 1 ? `${skipped[0].label} se omitirá: ${skipped[0].reason}` : `${skipped.length} wallets se omitirán (saldo o tokens insuficientes).`}</p>}
        {quoteError && <p className="pt-1 text-[11.5px] text-sell">{quoteError}</p>}
      </div>

      <button
        onClick={submit}
        disabled={!!disabledReason || busy}
        aria-describedby="ticket-reason"
        className={`mt-4 flex h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] text-[14px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
          buy ? "bg-buy text-[#04130a] hover:brightness-110" : "bg-sell text-white hover:brightness-110"
        }`}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : buy ? <ArrowUpRight className="size-4" aria-hidden /> : <ArrowDownRight className="size-4" aria-hidden />}
        {busy ? "Enviando…" : buy ? `Comprar con ${okCount} wallets` : `Vender ${pct} % en ${okCount} wallets`}
      </button>
      <p id="ticket-reason" className="mt-2 min-h-4 text-center text-[11.5px] text-faint">
        {disabledReason ?? `Slippage ${slip.toLocaleString("es-ES")} %: se envía exactamente este valor.`}
      </p>
    </section>
  );
}

function Row({ label, value, strong, hint }: { label: string; value: string; strong?: boolean; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-1 text-muted">
        {label}
        {hint && (
          <span title={hint} className="text-faint">
            <Info className="size-3" aria-label={hint} />
          </span>
        )}
      </dt>
      <dd className={`num ${strong ? "text-fg" : "text-muted"}`}>{value}</dd>
    </div>
  );
}
