"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { ArrowRight, Check, CheckCircle2, CircleSlash, Copy, ExternalLink, Loader2, PauseCircle, ShieldAlert, TriangleAlert, XCircle } from "lucide-react";
import type { WalletDto } from "@nebula/shared";
import { api, ApiError, confirmAction } from "@/lib/api";
import { fmtLamports, useChain } from "@/lib/chain";
import { toast } from "@/lib/toast";
import { executeOp, getOp, previewOp, resumeOp, solToLamportsStr, type OperationInput, type OperationView } from "@/lib/operations";
import { Modal } from "./dialogs";

const L = (s: string | bigint) => fmtLamports(typeof s === "bigint" ? s : BigInt(s), 9);
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

// ── Depositar (REQ-FUND-002): QR + detección del ingreso en ≤ 5 s ─────────────
function QrSvg({ text, size = 196 }: { text: string; size?: number }) {
  const { n, cells } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const cells: string[] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(`M${c} ${r}h1v1h-1z`);
    return { n, cells };
  }, [text]);
  return (
    <svg width={size} height={size} viewBox={`-2 -2 ${n + 4} ${n + 4}`} role="img" aria-label={`Código QR de ${text}`} className="rounded-[var(--radius-md)] bg-white">
      <path d={cells.join("")} fill="#07080c" shapeRendering="crispEdges" />
    </svg>
  );
}

export function DepositDialog({ wallet, onClose }: { wallet: WalletDto; onClose: () => void }) {
  const [lamports, setLamports] = useState<bigint | null>(null);
  const [incoming, setIncoming] = useState<bigint | null>(null);
  const [copied, setCopied] = useState(false);
  const first = useRef<bigint | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await api<{ lamports: string }>(`/balance/${wallet.address}`);
        if (!alive) return;
        const v = BigInt(r.lamports);
        if (first.current === null) first.current = v;
        else if (v > first.current) setIncoming(v - first.current);
        setLamports(v);
      } catch {}
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [wallet.address]);
  return (
    <Modal title={`Depositar en ${wallet.label}`} labelId="deposit-title" onClose={onClose} width={420}>
      <div className="mt-4 flex flex-col items-center gap-4">
        <QrSvg text={wallet.address} />
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(wallet.address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {}
          }}
          className="num flex w-full items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 px-3 py-2 text-left text-[12px] break-all hover:border-line-strong"
        >
          {wallet.address}
          {copied ? <Check className="size-4 shrink-0 text-buy" aria-label="Copiada" /> : <Copy className="size-4 shrink-0 text-muted" aria-label="Copiar dirección" />}
        </button>
        <div aria-live="polite" className="w-full rounded-[var(--radius-sm)] border border-line bg-surface-1 p-3 text-[13px]">
          <div className="flex justify-between">
            <span className="text-muted">Saldo</span>
            <span className="num">{lamports === null ? "leyendo…" : L(lamports)}</span>
          </div>
          {incoming ? (
            <p className="mt-2 flex items-center gap-2 text-buy">
              <CheckCircle2 className="size-4" aria-hidden /> Ingreso detectado: +{L(incoming)}
            </p>
          ) : (
            <p className="mt-2 flex items-center gap-2 text-faint">
              <span className="size-1.5 animate-pulse rounded-full bg-accent-b" aria-hidden /> Esperando el ingreso · se comprueba cada 2 s
            </p>
          )}
        </div>
        <p className="text-center text-[11.5px] text-faint">Envía solo SOL de Solana a esta dirección.</p>
      </div>
    </Modal>
  );
}

// ── Vista previa + ejecución + progreso de una operación ─────────────────────
function OperationPanel({ input, title, onClose, onDone }: { input: OperationInput; title: string; onClose: () => void; onDone: () => void }) {
  const [op, setOp] = useState<OperationView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [askPw, setAskPw] = useState(false);
  const [pw, setPw] = useState("");
  const [ackNew, setAckNew] = useState(false);
  const refreshBalances = useChain((s) => s.refreshBalances);

  useEffect(() => {
    let alive = true;
    previewOp(input)
      .then((v) => alive && setOp(v))
      .catch((e) => alive && setError((e as ApiError).message));
    return () => {
      alive = false;
    };
  }, [input]);

  // Progreso: la operación corre en el servidor aunque se cierre este diálogo
  useEffect(() => {
    if (!op || op.status !== "RUNNING") return;
    const id = setInterval(async () => {
      try {
        const v = await getOp(op.id);
        setOp(v);
        if (v.status !== "RUNNING") {
          await refreshBalances();
          onDone();
          const ok = v.items.filter((i) => i.status === "OK").length;
          toast({ tone: v.status === "COMPLETED" ? "info" : "warn", title: `${title}: ${v.status === "COMPLETED" ? "completada" : v.status === "PAUSED" ? "en pausa" : v.status === "PARTIAL" ? "parcial" : "fallida"}`, body: `${ok} transferencias confirmadas` });
        }
      } catch {}
    }, 1000);
    return () => clearInterval(id);
  }, [op, refreshBalances, onDone, title]);

  const withdraw = op?.kind === "withdraw";
  async function run() {
    if (!op) return;
    setBusy(true);
    setError("");
    try {
      let stepUp: string | undefined;
      if (withdraw) stepUp = await confirmAction(pw, "withdraw");
      setPw("");
      setOp(await executeOp(op.id, stepUp));
      setAskPw(false);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) {
        setOp(await getOp(op.id));
        setError("El coste o los saldos cambiaron. Revisa la nueva vista previa y confirma otra vez.");
      } else setError(err.code === "BAD_PASSWORD" ? "Contraseña incorrecta." : err.message);
    }
    setBusy(false);
  }

  if (error && !op) return <p className="mt-4 rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-3 text-[13px] text-sell">{error}</p>;
  if (!op) return <div className="skeleton mt-4 h-40" aria-busy="true" />;

  const pending = op.items.filter((i) => i.status !== "SKIPPED");
  const done = op.status !== "PREVIEW";
  return (
    <div className="mt-3">
      {op.external && (
        <div className={`mb-3 rounded-[var(--radius-sm)] border p-3 text-[12.5px] ${op.external.newAddress ? "border-warn/40 bg-[var(--warn-soft)] text-warn" : "border-line bg-surface-2/50"}`}>
          <p className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="size-4" aria-hidden /> Retiro a una dirección externa
          </p>
          <p className="num mt-1 break-all text-fg">{op.external.address}</p>
          {op.warnings.map((w) => (
            <p key={w} className="mt-1">
              {w}
            </p>
          ))}
        </div>
      )}
      {op.errors.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-[var(--radius-sm)] border border-sell/30 bg-[var(--sell-soft)] p-3 text-[12.5px] text-sell">
          {op.errors.map((e) => (
            <li key={e} className="flex gap-2">
              <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {e}
            </li>
          ))}
        </ul>
      )}

      <ul className="scroll-thin max-h-[260px] space-y-1 overflow-y-auto">
        {op.items.map((i) => (
          <li key={i.idx} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface-2/40 px-3 py-1.5 text-[12px]">
            {i.status === "OK" ? <CheckCircle2 className="size-3.5 text-buy" aria-label="confirmada" /> : i.status === "FAILED" ? <XCircle className="size-3.5 text-sell" aria-label="fallida" /> : i.status === "SKIPPED" ? <CircleSlash className="size-3.5 text-faint" aria-label="omitida" /> : done ? <Loader2 className="size-3.5 animate-spin text-muted" aria-label="enviando" /> : <ArrowRight className="size-3.5 text-faint" aria-hidden />}
            <span className="w-24 truncate">{i.fromLabel}</span>
            <ArrowRight className="size-3 text-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{i.toLabel ?? <span className="num">{short(i.to)}</span>}</span>
            <span className="num">{L(i.lamports)}</span>
            {i.signature && (
              <a href={`https://solscan.io/tx/${i.signature}`} target="_blank" rel="noreferrer" aria-label="Ver transacción" className="text-faint hover:text-fg">
                <ExternalLink className="size-3" />
              </a>
            )}
            {i.reason && <span className="w-full basis-full pl-6 text-[11.5px] text-warn">{i.reason}</span>}
          </li>
        ))}
      </ul>

      <dl className="mt-3 space-y-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/40 p-3 text-[12.5px]">
        <div className="flex justify-between">
          <dt className="text-muted">Total a mover ({pending.length})</dt>
          <dd className="num">{L(op.totalLamports)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Fees de red y priority ({op.chunks.length} tx)</dt>
          <dd className="num">{L(op.feeTotal)}</dd>
        </div>
        {op.sources.slice(0, 4).map((s) => (
          <div key={s.address} className="flex justify-between text-faint">
            <dt>{s.label} después</dt>
            <dd className="num">{L(s.after)}</dd>
          </div>
        ))}
      </dl>

      {error && <p className="mt-2 text-[12.5px] text-warn">{error}</p>}

      {op.status === "PREVIEW" ? (
        withdraw && askPw ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run();
            }}
            className="mt-4"
          >
            <label htmlFor="withdraw-pw" className="mb-1.5 block text-[13px] font-medium">
              Reconfirma la contraseña para retirar
            </label>
            <input id="withdraw-pw" autoFocus type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} className="field num h-10" />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn h-9">
                Cancelar
              </button>
              <button type="submit" disabled={!pw || busy} className="h-9 rounded-[var(--radius-md)] bg-sell px-4 text-[13px] font-semibold text-white disabled:opacity-50">
                {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
                Retirar {L(op.totalLamports)}
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-4">
            {withdraw && op.external?.newAddress && (
              <label className="mb-3 flex cursor-pointer items-start gap-2 text-[12.5px]">
                <input type="checkbox" checked={ackNew} onChange={(e) => setAckNew(e.target.checked)} className="mt-0.5 size-4 accent-[var(--warn)]" />
                He comprobado la dirección carácter a carácter.
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="btn h-9">
                Cancelar
              </button>
              <button
                onClick={() => (withdraw ? setAskPw(true) : run())}
                disabled={op.errors.length > 0 || busy || (withdraw && !!op.external?.newAddress && !ackNew)}
                className="cta cta-fill h-9 px-4 text-[13px] font-semibold"
              >
                {busy && <Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />}
                Confirmar y enviar
              </button>
            </div>
          </div>
        )
      ) : (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[12.5px] text-muted" aria-live="polite">
            {op.status === "RUNNING" ? "En curso en el servidor: puedes cerrar este diálogo." : op.status === "COMPLETED" ? "Completada." : op.status === "PAUSED" ? "En pausa." : op.status === "PARTIAL" ? "Parcial: revisa los motivos." : "Fallida."}
          </p>
          <div className="flex gap-2">
            {op.status === "PAUSED" && (
              <button onClick={async () => setOp(await resumeOp(op.id))} className="btn h-9">
                <PauseCircle className="size-3.5" aria-hidden /> Reanudar
              </button>
            )}
            <button onClick={onClose} className="btn h-9">
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Transferir / retirar ─────────────────────────────────────────────────────
export function TransferDialog({ from, own, onClose, onDone }: { from: WalletDto; own: WalletDto[]; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"own" | "external">("own");
  const [toId, setToId] = useState(own.find((w) => w.id !== from.id)?.id ?? "");
  const [ext, setExt] = useState("");
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [input, setInput] = useState<OperationInput | null>(null);
  const [book, setBook] = useState<{ address: string; label: string }[]>([]);
  useEffect(() => {
    api<{ items: { address: string; label: string }[] }>("/address-book")
      .then((r) => setBook(r.items))
      .catch(() => {});
  }, []);
  const to = mode === "own" ? own.find((w) => w.id === toId)?.address ?? "" : ext.trim();
  const lam = max ? null : solToLamportsStr(amount);
  const valid = to.length >= 32 && (max || lam);
  return (
    <Modal title={`Transferir desde ${from.label}`} labelId="transfer-title" onClose={onClose} width={520}>
      {input ? (
        <OperationPanel input={input} title="Transferencia" onClose={onClose} onDone={onDone} />
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) setInput({ kind: "transfer", fromId: from.id, to, ...(max ? { max: true } : { lamports: lam! }) });
          }}
        >
          <div role="radiogroup" aria-label="Destino" className="grid grid-cols-2 gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
            {(["own", "external"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`h-8 rounded-[6px] text-[12.5px] ${mode === m ? "bg-surface-3 text-fg" : "text-muted hover:text-fg"}`}>
                {m === "own" ? "Otra wallet propia" : "Dirección externa (retiro)"}
              </button>
            ))}
          </div>
          {mode === "own" ? (
            <select aria-label="Wallet de destino" value={toId} onChange={(e) => setToId(e.target.value)} className="field h-10 py-0">
              {own
                .filter((w) => w.id !== from.id)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label} · {short(w.address)}
                  </option>
                ))}
            </select>
          ) : (
            <div>
              <input aria-label="Dirección de destino" value={ext} onChange={(e) => setExt(e.target.value)} placeholder="Dirección de Solana (base58)" spellCheck={false} className="field num h-10" list="address-book" />
              <datalist id="address-book">
                {book.map((b) => (
                  <option key={b.address} value={b.address}>
                    {b.label}
                  </option>
                ))}
              </datalist>
              <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-warn">
                <TriangleAlert className="size-3" aria-hidden /> Un retiro exige reconfirmar la contraseña. Las direcciones nuevas se marcan de forma destacada.
              </p>
            </div>
          )}
          <div className="flex items-end gap-2">
            <label className="flex-1 text-[13px]">
              <span className="mb-1.5 block font-medium">Monto</span>
              <div className="relative">
                <input inputMode="decimal" value={max ? "MAX" : amount} disabled={max} onChange={(e) => setAmount(e.target.value)} placeholder="0,5" className="field num h-10 pr-12" />
                <span className="num pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12px] text-faint">SOL</span>
              </div>
            </label>
            <button type="button" aria-pressed={max} onClick={() => setMax((m) => !m)} className={`btn h-10 ${max ? "border-accent/50 text-fg" : ""}`} title="Todo el saldo menos la fee: el origen queda en 0">
              MAX
            </button>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn h-9">
              Cancelar
            </button>
            <button type="submit" disabled={!valid} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
              Ver vista previa
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ── Dispersar desde un funder a varias wallets ───────────────────────────────
export function DisperseDialog({ funders, targets, onClose, onDone, defaultAmount = "0,1" }: { funders: WalletDto[]; targets: WalletDto[]; onClose: () => void; onDone: () => void; defaultAmount?: string }) {
  const balances = useChain((s) => s.balances);
  const [fromId, setFromId] = useState(funders.find((f) => f.isDefaultFunder)?.id ?? funders[0]?.id ?? "");
  const [amount, setAmount] = useState(defaultAmount);
  const [input, setInput] = useState<OperationInput | null>(null);
  const lam = solToLamportsStr(amount);
  const from = funders.find((f) => f.id === fromId);
  return (
    <Modal title={`Dispersar a ${targets.length} wallets`} labelId="disperse-title" onClose={onClose} width={540}>
      {input ? (
        <OperationPanel input={input} title="Dispersión" onClose={onClose} onDone={onDone} />
      ) : funders.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">Crea un funder primero en la pantalla Funder.</p>
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (lam) setInput({ kind: "disperse", fromId, toIds: targets.map((t) => t.id), lamportsEach: lam });
          }}
        >
          <label className="block text-[13px]">
            <span className="mb-1.5 block font-medium">Desde</span>
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="field h-10 py-0">
              {funders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label} · {fmtLamports(balances[f.address], 3)}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[13px]">
            <span className="mb-1.5 block font-medium">SOL por wallet</span>
            <div className="relative">
              <input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!lam} className="field num h-10 pr-12" />
              <span className="num pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12px] text-faint">SOL</span>
            </div>
            <span className="mt-1 block text-[11.5px] text-faint">
              Total {lam ? fmtLamports(BigInt(lam) * BigInt(targets.length), 4) : "—"} + fees · saldo de {from?.label}: {fmtLamports(balances[from?.address ?? ""], 4)}
            </span>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn h-9">
              Cancelar
            </button>
            <button type="submit" disabled={!lam} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
              Ver vista previa
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ── Recolectar varias wallets en una (MAX: cada origen queda en 0) ───────────
export function CollectDialog({ sources, destinations, onClose, onDone }: { sources: WalletDto[]; destinations: WalletDto[]; onClose: () => void; onDone: () => void }) {
  const [toId, setToId] = useState(destinations.find((d) => d.isDefaultFunder)?.id ?? destinations[0]?.id ?? "");
  const [input, setInput] = useState<OperationInput | null>(null);
  return (
    <Modal title={`Recolectar ${sources.length} wallets`} labelId="collect-title" onClose={onClose} width={540}>
      {input ? (
        <OperationPanel input={input} title="Recolección" onClose={onClose} onDone={onDone} />
      ) : (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (toId) setInput({ kind: "collect", fromIds: sources.map((s) => s.id), toId });
          }}
        >
          <label className="block text-[13px]">
            <span className="mb-1.5 block font-medium">Hacia</span>
            <select value={toId} onChange={(e) => setToId(e.target.value)} className="field h-10 py-0">
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                  {d.isDefaultFunder ? " · funder predeterminado" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[12px] text-muted">Cada origen envía todo su saldo menos su propia fee y queda exactamente en 0.</p>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn h-9">
              Cancelar
            </button>
            <button type="submit" disabled={!toId} className="cta cta-fill h-9 px-4 text-[13px] font-semibold">
              Ver vista previa
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
