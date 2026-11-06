"use client";

import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Info, Loader2 } from "lucide-react";
import { priceSol, useSim, type Wallet } from "@/lib/sim";
import { estimate, maxBuyPerWallet, PAD_FEE_PCT, runOrder } from "@/lib/trade";
import { fmtSol } from "@/lib/format";

type Side = "buy" | "sell";

export function useWalletPicker() {
  const wallets = useSim((s) => s.wallets);
  const folders = useSim((s) => s.folders);
  const [scope, setScope] = useState<string>("f-holders");
  const [includeDev, setIncludeDev] = useState(false);
  const selected = useMemo(() => {
    const base = scope === "all" ? wallets : wallets.filter((w) => w.folder === scope);
    return base.filter((w) => includeDev || w.role !== "dev" || scope === "f-dev");
  }, [wallets, scope, includeDev]);
  return { wallets, folders, scope, setScope, includeDev, setIncludeDev, selected };
}

export function TradeTicket() {
  const [side, setSide] = useState<Side>("buy");
  const { folders, scope, setScope, includeDev, setIncludeDev, selected } = useWalletPicker();
  const [amount, setAmount] = useState("0,1");
  const [pct, setPct] = useState(25);
  const [slippage, setSlippage] = useState({ buy: "15", sell: "5" });
  const [mode, setMode] = useState<"parallel" | "staggered">("parallel");
  const [busy, setBusy] = useState(false);

  const amt = Number(amount.replace(",", ".")) || 0;
  const slip = Number(slippage[side].replace(",", ".")) || 0;
  const holding = selected.filter((w) => w.tokens > 0);
  const mc = useSim((s) => s.mc);
  const sellPreviewSol = holding.reduce((a, w) => a + w.tokens * (pct / 100), 0) * priceSol(mc);
  const est = estimate(side, side === "buy" ? selected : holding, side === "buy" ? amt : sellPreviewSol);
  const max = maxBuyPerWallet(selected);

  const amountError = side === "buy" && amt <= 0 ? "Indica un monto mayor que 0." : side === "buy" && amt > max ? `Supera el máximo por wallet (${fmtSol(max)}).` : null;
  const slipError = slip <= 0 || slip > 50 ? "Entre 0,1 % y 50 %." : null;
  const emptySel = side === "buy" ? selected.length === 0 : holding.length === 0;
  const disabledReason = emptySel ? (side === "buy" ? "No hay wallets en la selección." : "Ninguna wallet seleccionada tiene tokens.") : amountError ?? slipError;

  async function submit() {
    if (disabledReason) return;
    setBusy(true);
    await runOrder(
      { side, walletIds: (side === "buy" ? selected : holding).map((w: Wallet) => w.id), amountSol: amt, pct, slippage: slip },
      `Ticket · ${mode === "parallel" ? "en paralelo" : "escalonado"}`,
    );
    setBusy(false);
  }

  const buy = side === "buy";

  return (
    <section aria-label="Ticket de compra y venta" className="panel reticle flex flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="telemetry">02 · Ticket</p>
        <span className="chip h-5 px-2 text-[10.5px]">bonding curve</span>
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
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              Carpeta · {f.name}
            </option>
          ))}
          <option value="all">Todas las wallets</option>
        </select>
        <span className="chip num h-9 shrink-0 rounded-[var(--radius-sm)] px-3">{buy ? selected.length : holding.length} sel.</span>
      </div>
      {scope !== "f-dev" && (
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
          <input type="checkbox" checked={includeDev} onChange={(e) => setIncludeDev(e.target.checked)} className="size-3.5 accent-[var(--accent-a)]" />
          Incluir wallet dev {includeDev && <span className="chip h-5 border-warn/30 px-1.5 text-[10.5px] text-warn">incl. dev</span>}
        </label>
      )}

      {buy ? (
        <>
          <label className="mt-4 mb-1.5 flex justify-between text-[12px] text-muted" htmlFor="ticket-amount">
            SOL por wallet <span className="num text-faint">máx. {fmtSol(max)}</span>
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
            <button onClick={() => setAmount(max.toLocaleString("es-ES"))} className="btn h-8 px-0 text-[11.5px]" title="Reserva fees y rent">
              MAX
            </button>
          </div>
          {amountError && <p id="ticket-amount-err" className="mt-1.5 text-[12px] text-sell">{amountError}</p>}
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
              <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`rounded-[6px] text-[11.5px] ${mode === m ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
                {m === "parallel" ? "Paralelo" : "Escalonado"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <dl className="mt-4 space-y-1.5 rounded-[var(--radius-sm)] border border-line bg-surface-2/40 p-3 text-[12px]">
        <Row label={buy ? `Compras (${est.n} × ${fmtSol(amt)})` : `Recibes aprox. (${est.n} wallets)`} value={fmtSol(est.volume)} strong />
        <Row label="Fee de red" value={fmtSol(est.network, 6)} />
        <Row label="Priority fee" value={fmtSol(est.priority, 5)} />
        {est.rent > 0 && <Row label="Rent de cuentas nuevas" value={fmtSol(est.rent, 5)} hint="Se recupera al cerrar la cuenta de token vacía." />}
        <Row label={`Fee Pump.fun (${PAD_FEE_PCT} %)`} value={fmtSol(est.pad, 4)} hint="Valor de demostración. En F1 lo da el adaptador." />
        <div className="my-1 border-t border-line" />
        <Row label={buy ? "Total a gastar" : "Coste de la operación"} value={fmtSol(est.total, 4)} strong />
      </dl>

      <button
        onClick={submit}
        disabled={!!disabledReason || busy}
        aria-describedby="ticket-reason"
        className={`mt-4 flex h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] text-[14px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
          buy ? "bg-buy text-[#04130a] hover:brightness-110" : "bg-sell text-white hover:brightness-110"
        }`}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : buy ? <ArrowUpRight className="size-4" aria-hidden /> : <ArrowDownRight className="size-4" aria-hidden />}
        {busy ? "Enviando…" : buy ? `Comprar con ${selected.length} wallets` : `Vender ${pct} % en ${holding.length} wallets`}
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
