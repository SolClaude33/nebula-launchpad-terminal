"use client";

// REQ-LIVE-005: enviar tokens y quemar supply desde las wallets propias, con vista previa por wallet
// (cantidad, fee de red y rent de la cuenta de destino). Enviar fuera de la bóveda pide reconfirmar la
// contraseña; quemar pide escribir el símbolo (lo comprueba también el servidor).
import { useMemo, useState } from "react";
import { CheckCircle2, Clock, Flame, Loader2, Send, ShieldAlert, TriangleAlert, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { refreshLive, toTokens, useLive } from "@/lib/live";
import { fmtSol, fmtTokens, shortAddr } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Modal, StepUpDialog } from "@/components/wallets/dialogs";

type Item = { walletId: string; label: string; address: string; balance: string; amount: string; feeLamports: string; rentLamports: string; status: "READY" | "SKIPPED" | "OK" | "FAILED" | "PENDING"; reason: string | null; signature: string | null };
type Preview = { kind: "send" | "burn"; symbol: string | null; to: { address: string; own: { id: string; label: string } | null; newAddress: boolean; offCurve: boolean } | null; needsStepUp?: boolean; items: Item[]; totals: { tokens: string; feeLamports?: string; rentLamports?: string } };

export function TokenActions() {
  const [open, setOpen] = useState<"send" | "burn" | null>(null);
  const position = useLive((s) => s.position);
  const holding = (position?.items ?? []).filter((i) => BigInt(i.tokens) > 0n);
  return (
    <div className="mt-3 flex gap-2">
      <button onClick={() => setOpen("send")} disabled={holding.length === 0} className="btn h-8 flex-1 px-3 text-[12px]">
        <Send className="size-3.5" aria-hidden /> Enviar
      </button>
      <button onClick={() => setOpen("burn")} disabled={holding.length === 0} className="btn h-8 flex-1 px-3 text-[12px] hover:border-sell/40 hover:text-sell">
        <Flame className="size-3.5" aria-hidden /> Quemar
      </button>
      {open && <TokenDialog kind={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`);

function TokenDialog({ kind, onClose }: { kind: "send" | "burn"; onClose: () => void }) {
  const mint = useLive((s) => s.mint)!;
  const info = useLive((s) => s.info)!;
  const position = useLive((s) => s.position)!;
  const wallets = useLive((s) => s.wallets);
  const holding = position.items.filter((i) => BigInt(i.tokens) > 0n);
  const [sel, setSel] = useState<Set<string>>(() => new Set(holding.slice(0, 1).map((h) => h.walletId)));
  const [mode, setMode] = useState<"pct" | "tokens">("pct");
  const [pct, setPct] = useState("100");
  const [amount, setAmount] = useState("");
  const [toKind, setToKind] = useState<"own" | "ext">("own");
  const [toOwn, setToOwn] = useState("");
  const [toExt, setToExt] = useState("");
  const [symbol, setSymbol] = useState("");
  const [pv, setPv] = useState<Preview | null>(null);
  const [result, setResult] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [id] = useState(newId);

  const ownTargets = (wallets ?? []).filter((w) => w.kind === "wallet" && !sel.has(w.id));
  const to = toKind === "own" ? ((wallets ?? []).find((w) => w.id === toOwn)?.address ?? "") : toExt.trim();
  const body = useMemo(() => {
    const amt = mode === "pct" ? { pct: Number(pct.replace(",", ".")) } : { tokensEach: String(Math.floor(Number(amount.replace(",", ".")) * 10 ** info.decimals)) };
    return { id, mint, walletIds: [...sel], ...amt, ...(kind === "send" ? { to } : { confirmSymbol: symbol }) };
  }, [id, mint, sel, mode, pct, amount, info.decimals, kind, to, symbol]);
  const invalid = sel.size === 0 || (mode === "pct" ? !(Number(pct.replace(",", ".")) > 0 && Number(pct.replace(",", ".")) <= 100) : !(Number(amount.replace(",", ".")) > 0)) || (kind === "send" && !to);

  const preview = async () => {
    setBusy("preview");
    setError(null);
    try {
      setPv(await api<Preview>(`/tokens/${kind}/preview`, { method: "POST", body }));
    } catch (e) {
      setError((e as ApiError).message);
      setPv(null);
    }
    setBusy(null);
  };
  const run = async (stepUp?: string) => {
    setBusy("run");
    setError(null);
    try {
      const r = await api<Preview>(`/tokens/${kind}`, { method: "POST", body, stepUp });
      setResult(r);
      const ok = r.items.filter((i) => i.status === "OK").length;
      toast({ tone: ok ? "buy" : "warn", title: kind === "send" ? `Envío: ${ok} de ${r.items.length} wallets` : `Quema: ${ok} de ${r.items.length} wallets`, lines: r.items.map((i) => ({ label: i.label, status: i.status === "OK" ? "ok" : i.status === "PENDING" ? "pending" : i.status === "SKIPPED" ? "skipped" : "failed", detail: i.reason ?? undefined })) });
      void refreshLive();
    } catch (e) {
      setError((e as ApiError).message);
    }
    setBusy(null);
  };
  const confirm = () => (kind === "send" && pv?.needsStepUp ? setAsk(true) : run());

  const sym = pv?.symbol ?? null;
  const symbolOk = kind !== "burn" || (symbol.trim().replace(/^\$/, "").toUpperCase() === (sym ?? "QUEMAR").toUpperCase());
  const shown = result ?? pv;
  const tok = (v: string) => fmtTokens(toTokens(v, info.decimals));

  return (
    <>
      <Modal
        title={
          <span className="flex items-center gap-2">
            {kind === "send" ? <Send className="size-4 text-accent-b" aria-hidden /> : <Flame className="size-4 text-sell" aria-hidden />}
            {kind === "send" ? "Enviar tokens" : "Quemar supply"}
          </span>
        }
        labelId="tokens-title"
        onClose={onClose}
        width={560}
      >
        {kind === "burn" && <p className="mt-1 text-[12.5px] text-muted">Quemar destruye los tokens para siempre: la supply baja y no se recuperan.</p>}
        <fieldset className="mt-4" disabled={!!result}>
          <legend className="mb-1.5 text-[12.5px] font-medium">Desde</legend>
          <ul className="scroll-thin max-h-36 space-y-1 overflow-y-auto rounded-[var(--radius-sm)] border border-line p-1.5">
            {holding.map((h) => (
              <li key={h.walletId}>
                <label className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1 text-[12.5px] hover:bg-surface-2">
                  <input type="checkbox" checked={sel.has(h.walletId)} onChange={(e) => (setPv(null), setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(h.walletId); else n.delete(h.walletId); return n; }))} className="accent-[var(--accent-b)]" />
                  <span className="flex-1 truncate">{h.label}</span>
                  <span className="num text-faint">{tok(h.tokens)}</span>
                </label>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-end gap-3">
            <div role="radiogroup" aria-label="Cantidad" className="inline-flex gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
              {(
                [
                  ["pct", "% del saldo"],
                  ["tokens", "Tokens por wallet"],
                ] as const
              ).map(([k, l]) => (
                <button type="button" key={k} role="radio" aria-checked={mode === k} onClick={() => (setMode(k), setPv(null))} className={`h-7 rounded-[6px] px-2.5 text-[12px] font-medium ${mode === k ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
                  {l}
                </button>
              ))}
            </div>
            {mode === "pct" ? (
              <div className="flex items-center gap-1.5">
                {["25", "50", "100"].map((p) => (
                  <button type="button" key={p} onClick={() => (setPct(p), setPv(null))} className={`chip h-7 px-2.5 ${pct === p ? "border-accent-b/40 text-fg" : ""}`}>
                    {p} %
                  </button>
                ))}
                <label className="sr-only" htmlFor="tk-pct">
                  Porcentaje
                </label>
                <input id="tk-pct" inputMode="decimal" value={pct} onChange={(e) => (setPct(e.target.value), setPv(null))} className="field num h-8 w-20 text-[12.5px]" />
              </div>
            ) : (
              <div>
                <label className="sr-only" htmlFor="tk-amt">
                  Tokens por wallet
                </label>
                <input id="tk-amt" inputMode="decimal" placeholder="p. ej. 1.000.000" value={amount} onChange={(e) => (setAmount(e.target.value), setPv(null))} className="field num h-8 w-40 text-[12.5px]" />
              </div>
            )}
          </div>

          {kind === "send" && (
            <div className="mt-3">
              <p className="mb-1.5 text-[12.5px] font-medium">Hacia</p>
              <div className="flex gap-2">
                <select aria-label="Tipo de destino" value={toKind} onChange={(e) => (setToKind(e.target.value as "own" | "ext"), setPv(null))} className="field h-9 w-44 text-[12.5px]">
                  <option value="own">Wallet propia</option>
                  <option value="ext">Dirección externa</option>
                </select>
                {toKind === "own" ? (
                  <select aria-label="Wallet de destino" value={toOwn} onChange={(e) => (setToOwn(e.target.value), setPv(null))} className="field h-9 flex-1 text-[12.5px]">
                    <option value="">Elige una wallet…</option>
                    {ownTargets.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.label} · {shortAddr(w.address)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input aria-label="Dirección de destino" spellCheck={false} placeholder="Dirección de Solana" value={toExt} onChange={(e) => (setToExt(e.target.value), setPv(null))} className="field num h-9 flex-1 text-[12.5px]" />
                )}
              </div>
            </div>
          )}
        </fieldset>

        {pv?.to && !pv.to.own && !result && (
          <p className={`mt-3 flex items-start gap-2 rounded-[var(--radius-sm)] border p-2.5 text-[12px] ${pv.to.offCurve ? "border-sell/30 bg-[var(--sell-soft)] text-sell" : pv.to.newAddress ? "border-warn/30 bg-[var(--warn-soft)] text-warn" : "border-line text-muted"}`}>
            {pv.to.offCurve ? <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
            {pv.to.offCurve ? "Es una dirección de programa (PDA): los tokens quedarían bloqueados. No se puede enviar." : pv.to.newAddress ? "Dirección nueva: no está en tu libreta. Comprueba cada carácter. Saldrán tokens de la bóveda y se pedirá la contraseña." : "Dirección externa conocida. Se pedirá la contraseña."}
          </p>
        )}

        {shown && (
          <div className="mt-3 overflow-hidden rounded-[var(--radius-sm)] border border-line">
            <table className="num w-full text-[12px]">
              <thead className="bg-surface-2/60 text-faint">
                <tr>
                  <th className="px-2.5 py-1.5 text-left font-normal">Wallet</th>
                  <th className="px-2.5 py-1.5 text-right font-normal">Tokens</th>
                  <th className="px-2.5 py-1.5 text-right font-normal">Fee + rent</th>
                  <th className="px-2.5 py-1.5 text-left font-normal">Estado</th>
                </tr>
              </thead>
              <tbody>
                {shown.items.map((i) => (
                  <tr key={i.walletId} className="border-t border-line">
                    <td className="px-2.5 py-1.5">{i.label}</td>
                    <td className="px-2.5 py-1.5 text-right">{tok(i.amount)}</td>
                    <td className="px-2.5 py-1.5 text-right" title={`Fee de red ${fmtSol(Number(i.feeLamports) / 1e9, 6)} · rent de la cuenta de destino ${fmtSol(Number(i.rentLamports) / 1e9, 6)}`}>
                      {fmtSol((Number(i.feeLamports) + Number(i.rentLamports)) / 1e9, 6)}
                    </td>
                    <td className="px-2.5 py-1.5">
                      <StatusCell i={i} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {kind === "burn" && pv && !result && (
          <div className="mt-3">
            <label htmlFor="burn-sym" className="mb-1.5 block text-[12.5px] font-medium">
              Escribe {sym ? <span className="num">${sym}</span> : <span className="num">QUEMAR</span>} para confirmar
            </label>
            <input id="burn-sym" autoComplete="off" spellCheck={false} value={symbol} onChange={(e) => setSymbol(e.target.value)} className="field num h-9 text-[12.5px]" aria-invalid={symbol.length > 0 && !symbolOk} />
          </div>
        )}

        <p aria-live="polite" className="mt-2 min-h-5 text-[12.5px] text-sell">
          {error}
        </p>
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn h-9">
            {result ? "Cerrar" : "Cancelar"}
          </button>
          {!result &&
            (!pv ? (
              <button type="button" onClick={preview} disabled={invalid || busy !== null} className="cta cta-fill flex h-9 items-center gap-1.5 px-4 text-[13px] font-semibold disabled:opacity-50">
                {busy === "preview" && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Vista previa
              </button>
            ) : (
              <button
                type="button"
                onClick={confirm}
                disabled={busy !== null || !pv.items.some((i) => i.status === "READY") || !symbolOk || !!pv.to?.offCurve}
                className={`flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] px-4 text-[13px] font-semibold disabled:opacity-50 ${kind === "burn" ? "bg-sell text-white hover:brightness-110" : "cta cta-fill"}`}
              >
                {busy === "run" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                {kind === "send" ? `Enviar ${tok(pv.totals.tokens)}` : `Quemar ${tok(pv.totals.tokens)}`}
              </button>
            ))}
        </div>
      </Modal>
      {ask && (
        <StepUpDialog
          action="withdraw"
          title="Enviar tokens fuera de la bóveda"
          body={`Destino ${pv?.to?.address ?? ""}. Reconfirma la contraseña para continuar.`}
          danger={!!pv?.to?.newAddress}
          onClose={() => setAsk(false)}
          onToken={async (t) => {
            setAsk(false);
            await run(t);
          }}
        />
      )}
    </>
  );
}

function StatusCell({ i }: { i: Item }) {
  const map = {
    READY: { icon: <CheckCircle2 className="size-3.5 text-buy" aria-hidden />, text: "Lista" },
    SKIPPED: { icon: <TriangleAlert className="size-3.5 text-warn" aria-hidden />, text: "Omitida" },
    OK: { icon: <CheckCircle2 className="size-3.5 text-buy" aria-hidden />, text: "Entró" },
    FAILED: { icon: <XCircle className="size-3.5 text-sell" aria-hidden />, text: "Falló" },
    PENDING: { icon: <Clock className="size-3.5 text-warn" aria-hidden />, text: "Pendiente" },
  }[i.status];
  return (
    <span className="flex items-center gap-1.5" title={i.reason ?? undefined}>
      {map.icon}
      {map.text}
      {i.reason && <span className="max-w-[140px] truncate text-faint">· {i.reason}</span>}
    </span>
  );
}
