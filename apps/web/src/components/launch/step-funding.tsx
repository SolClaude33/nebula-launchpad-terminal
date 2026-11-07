"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, GripVertical, Landmark, Plus, X } from "lucide-react";
import { amountText, buysAfterCreate, delayOf, delayTimeline, fieldErrors, fmtMs, fundingNeeds, num, planAmounts, toLamports, useDraft } from "@/lib/draft";
import { fmtLamports, useChain } from "@/lib/chain";
import { DisperseDialog } from "@/components/wallets/funds-dialogs";
import { SectionTitle } from "./ui";
import { useLaunchData } from "./use-launch-data";

const COLS = "grid-cols-[24px_minmax(0,1fr)_84px_92px_110px] xl:grid-cols-[28px_minmax(0,1fr)_110px_120px_140px]";
/** Modo Pro: columna extra «Espera» */
const COLS_PRO = "grid-cols-[24px_minmax(0,1fr)_96px_84px_92px_110px] xl:grid-cols-[28px_minmax(0,1fr)_120px_110px_120px_140px]";
const short = (a?: string) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "—");

type RowProps = {
  id: string;
  i: number;
  dev?: boolean;
  label?: string;
  address?: string;
  amount: bigint;
  have?: bigint;
  shortBy: bigint;
  dragging: boolean;
  onDragStart: () => void;
  onDrop: () => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  /** Modo Pro: espera de esta wallet y segundo acumulado en que compraría (sin contar confirmaciones) */
  pro?: { value: string; at: number; invalid: boolean; onChange: (v: string) => void };
  /** Monto «Por wallet»: casilla editable en la columna Compra */
  amountEdit?: { value: string; invalid: boolean; onChange: (v: string) => void };
  cols: string;
};

function PlanRow({ i, dev, label, address, amount, have, shortBy, dragging, onDragStart, onDrop, onMove, onRemove, pro, amountEdit, cols }: RowProps) {
  return (
    <li
      draggable={!dev}
      onDragStart={() => !dev && onDragStart()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => !dev && onDrop()}
      className={`group grid ${cols} items-center gap-3 border-b border-line/50 px-4 py-2.5 text-[12.5px] last:border-0 ${dev ? "bg-surface-2/30" : dragging ? "opacity-40" : "hover:bg-surface-2/50"}`}
    >
      <span className="flex items-center gap-0.5 text-faint">
        {!dev && <GripVertical className="size-3.5 cursor-grab" aria-hidden />}
        <span className="num">{dev ? 0 : i + 1}</span>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0">
          <span className="font-medium">{label ?? "—"}</span>
          {dev && <span className="chip ml-1.5 h-5 border-warn/30 px-1.5 text-[10.5px] text-warn">creación + dev buy</span>}
          <span className="num block text-[11px] text-faint">{short(address)}</span>
        </span>
        {!dev && (
          <span className="ml-auto flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <button onClick={() => onMove(i - 1)} aria-label={`Subir ${label}`} className="btn-ghost grid size-6 place-items-center rounded">
              <ArrowUp className="size-3" />
            </button>
            <button onClick={() => onMove(i + 1)} aria-label={`Bajar ${label}`} className="btn-ghost grid size-6 place-items-center rounded">
              <ArrowDown className="size-3" />
            </button>
            <button onClick={onRemove} aria-label={`Quitar ${label}`} className="btn-ghost grid size-6 place-items-center rounded">
              <X className="size-3" />
            </button>
          </span>
        )}
      </span>
      {cols === COLS_PRO &&
        (dev || !pro ? (
          <span className="num text-right text-[12px] text-muted">T+0 ms</span>
        ) : (
          <span className="flex flex-col items-end gap-0.5">
            <span className="relative">
              <input aria-label={`Espera antes de la compra de ${label}`} inputMode="numeric" value={pro.value} placeholder="0" onChange={(e) => pro.onChange(e.target.value)} aria-invalid={pro.invalid} className="field num h-7 w-[84px] pr-7 text-right text-[12px]" />
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10.5px] text-faint">ms</span>
            </span>
            <span className="num text-[10.5px] text-faint">{pro.invalid ? "0–10.000 ms" : `≈ T+${fmtMs(pro.at)}`}</span>
          </span>
        ))}
      {amountEdit ? (
        <span className="relative justify-self-end">
          <input aria-label={`SOL de la compra de ${label}`} inputMode="decimal" value={amountEdit.value} onChange={(e) => amountEdit.onChange(e.target.value)} aria-invalid={amountEdit.invalid} className="field num h-7 w-[84px] pr-9 text-right text-[12px]" />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10.5px] text-faint">SOL</span>
        </span>
      ) : (
        <span className="num text-right">{fmtLamports(amount, 3)}</span>
      )}
      <span className="num text-right text-muted">{fmtLamports(have, 3)}</span>
      {shortBy > 0n ? (
        <span className="num text-right text-[12px] text-warn">faltan {fmtLamports(shortBy, 4)}</span>
      ) : (
        <span className="flex items-center justify-end gap-1 text-[12px] text-buy">
          <CheckCircle2 className="size-3.5" aria-hidden /> listo
        </span>
      )}
    </li>
  );
}

export function StepFunding() {
  const d = useDraft((s) => s.draft);
  const set = useDraft((s) => s.set);
  const { wallets, byId, addressOf, balances, refresh } = useLaunchData();
  const [dragId, setDragId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("role:holder");
  const [funding, setFunding] = useState(false);

  const needs = fundingNeeds(d, { balances, addressOf });
  const byNeed = new Map(needs.map((n) => [n.walletId, n]));
  const amounts = planAmounts(d);
  const shortList = needs.filter((n) => n.short > 0n);
  const maxShort = shortList.reduce((a, n) => (n.short > a ? n.short : a), 0n);
  const toSend = shortList.reduce((a, n) => a + n.short, 0n);
  const isPro = d.launchMode === "pro";
  const cols = isPro ? COLS_PRO : COLS;
  const timeline = delayTimeline(d);
  const [allDelay, setAllDelay] = useState("500");
  const fe = fieldErrors(d);
  const delayErr = fe.delays;
  // Con un límite de envíos (Helius Free: 1/s), dos compras no pueden salir más juntas que 1000 / límite ms
  const sendPerSec = useChain((s) => s.status?.sendPerSec ?? 0);
  const minGap = sendPerSec > 0 ? Math.ceil(1000 / sendPerSec) : 0;
  const tooTight = isPro && minGap > 0 && d.plan.some((id, i) => i > 0 && (delayOf(d, id) || 0) < minGap);
  const custom = buysAfterCreate(d) && d.amountMode === "custom";
  const funders = wallets.filter((w) => w.kind === "funder" && !w.archived);
  const def = funders.find((f) => f.isDefaultFunder);
  const folders = useMemo(() => [...new Set(wallets.flatMap((w) => w.folderIds))], [wallets]);
  const roles = [...new Set(wallets.map((w) => w.role).filter(Boolean))] as string[];
  const candidates = wallets.filter(
    (w) => w.kind === "wallet" && !w.archived && w.id !== d.devWalletId && !d.plan.includes(w.id) && (filter === "all" || (filter.startsWith("role:") ? w.role === filter.slice(5) : w.folderIds.includes(filter.slice(7)))),
  );

  const move = (from: number, to: number) => {
    if (to < 0 || to >= d.plan.length) return;
    const plan = d.plan.slice();
    const [it] = plan.splice(from, 1);
    plan.splice(to, 0, it);
    set({ plan });
  };
  const rowProps = (id: string, i: number, dev = false): RowProps => {
    const w = byId.get(id);
    const n = byNeed.get(id);
    return {
      id,
      i,
      dev,
      label: w?.label,
      address: w?.address,
      amount: dev ? toLamports(d.devBuy) : amounts[i],
      have: n?.have,
      shortBy: n?.short ?? 0n,
      cols,
      amountEdit: custom && !dev ? { value: amountText(d, id), invalid: !(num(amountText(d, id)) > 0), onChange: (v) => set({ amounts: { ...d.amounts, [id]: v } }) } : undefined,
      pro: isPro && !dev ? { value: d.delaysMs?.[id] ?? "", at: timeline[i] ?? 0, invalid: Number.isNaN(delayOf(d, id)), onChange: (v) => set({ delaysMs: { ...d.delaysMs, [id]: v } }) } : undefined,
      dragging: dragId === id,
      onDragStart: () => setDragId(id),
      onDrop: () => {
        const from = d.plan.indexOf(dragId ?? "");
        if (from >= 0) move(from, i);
        setDragId(null);
      },
      onMove: (to) => move(i, to),
      onRemove: () => set({ plan: d.plan.filter((p) => p !== id) }),
    };
  };

  return (
    <div className="rise">
      <SectionTitle index="Paso 3 de 4 · Financiación" title="Fondos del plan" body="Cada wallet necesita su compra más fees y su cuenta de token. Lo que falte se dispersa desde el funder." />

      <div className="mb-5 grid grid-cols-3 gap-3">
        <div className="panel p-4">
          <p className="telemetry flex items-center gap-1.5">
            <Landmark className="size-3" aria-hidden /> Funder predeterminado
          </p>
          {def ? (
            <>
              <p className="num mt-1.5 text-[20px]">{fmtLamports(balances[def.address], 3)}</p>
              <p className="num text-[11.5px] text-faint">{short(def.address)}</p>
            </>
          ) : (
            <p className="mt-1.5 text-[13px] text-muted">Aún no hay funder</p>
          )}
        </div>
        <div className="panel p-4">
          <p className="telemetry">Falta dispersar</p>
          <p className={`num mt-1.5 text-[20px] ${toSend > 0n ? "text-warn" : "text-buy"}`}>{fmtLamports(toSend, 4)}</p>
          <p className="text-[11.5px] text-faint">{shortList.length} wallets por debajo de lo necesario</p>
        </div>
        <div className="panel p-4">
          <p className="telemetry">Wallets en el plan</p>
          <p className="num mt-1.5 text-[20px]">{buysAfterCreate(d) ? d.plan.length : 0}</p>
          <p className="text-[11.5px] text-faint">{isPro ? `compran en este orden; esperas que suman ${fmtMs(timeline.at(-1) ?? 0)}` : buysAfterCreate(d) ? "compran en este orden tras crear el token" : "modo Manual: solo dev"}</p>
        </div>
      </div>

      <div className={`panel overflow-hidden${d.review?.includes("plan") ? " ring-2 ring-warn/60 ring-offset-2 ring-offset-[var(--bg)]" : ""}`}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="text-[13px] font-medium">
            Orden de compra <span className={`ml-1 text-[12px] font-normal text-faint ${isPro ? "hidden xl:inline" : ""}`}>arrastra o usa las flechas</span>
          </p>
          {isPro && d.plan.length > 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                set({ delaysMs: { ...d.delaysMs, ...Object.fromEntries(d.plan.map((id) => [id, allDelay])) } });
              }}
              className="ml-auto mr-2 flex items-center gap-1.5 text-[12px] text-muted"
            >
              <label htmlFor="all-delay" className="whitespace-nowrap">Espera para todas</label>
              <input id="all-delay" inputMode="numeric" value={allDelay} onChange={(e) => setAllDelay(e.target.value)} className="field num h-8 w-[72px] text-right text-[12px]" />
              <span>ms</span>
              <button type="submit" className="btn h-8 text-[12px]">
                Aplicar
              </button>
            </form>
          )}
          {buysAfterCreate(d) && (
            <button onClick={() => setAdding((a) => !a)} aria-expanded={adding} className="btn h-8 whitespace-nowrap">
              <Plus className="size-3.5" aria-hidden /> Añadir wallets
            </button>
          )}
        </div>
        {adding && (
          <div className="border-b border-line bg-surface-2/30 p-3">
            <div className="flex items-center gap-2">
              <select aria-label="Filtrar candidatas" value={filter} onChange={(e) => setFilter(e.target.value)} className="field h-8 w-auto py-0 text-[12.5px]">
                <option value="all">Todas</option>
                {roles.map((r) => (
                  <option key={r} value={`role:${r}`}>
                    Rol · {r}
                  </option>
                ))}
                {folders.map((f) => (
                  <option key={f} value={`folder:${f}`}>
                    Carpeta · {f.slice(0, 8)}
                  </option>
                ))}
              </select>
              <button onClick={() => set({ plan: [...d.plan, ...candidates.map((c) => c.id)] })} disabled={candidates.length === 0} className="btn h-8 text-[12.5px]">
                Añadir las {candidates.length}
              </button>
            </div>
            <ul className="scroll-thin mt-2 max-h-40 space-y-1 overflow-y-auto">
              {candidates.slice(0, 50).map((c) => (
                <li key={c.id}>
                  <button onClick={() => set({ plan: [...d.plan, c.id] })} className="flex w-full items-center justify-between rounded-[var(--radius-sm)] px-2 py-1 text-left text-[12.5px] hover:bg-surface-2">
                    <span>{c.label}</span>
                    <span className="num text-faint">{fmtLamports(balances[c.address], 3)}</span>
                  </button>
                </li>
              ))}
              {candidates.length === 0 && <li className="px-2 py-1 text-[12px] text-faint">No hay más wallets con este filtro.</li>}
            </ul>
          </div>
        )}
        {custom && fe.amounts && <p className="border-b border-line px-4 py-2 text-[11.5px] text-sell">{fe.amounts}</p>}
        {isPro && (
          <p className={`border-b border-line px-4 py-2 text-[11.5px] ${delayErr ? "text-sell" : "text-faint"}`}>
            {delayErr ?? "La espera de cada wallet cuenta desde que SALE la compra anterior (la primera, desde que se confirma la creación). Las confirmaciones no frenan la siguiente compra."}
          </p>
        )}
        {tooTight && !delayErr && (
          <p className="border-b border-line bg-[var(--warn-soft)] px-4 py-2 text-[11.5px] text-warn">
            Tu RPC admite {sendPerSec} envío{sendPerSec === 1 ? "" : "s"} por segundo: entre dos compras habrá al menos {fmtMs(minGap)} aunque pongas menos.
          </p>
        )}
        <div aria-hidden className={`grid ${cols} gap-3 border-b border-line bg-surface-2/40 px-4 py-2`}>
          <span />
          <span className="telemetry">Wallet</span>
          {isPro && <span className="telemetry text-right">Espera</span>}
          <span className="telemetry text-right">Compra</span>
          <span className="telemetry text-right">Saldo</span>
          <span className="telemetry text-right">Estado</span>
        </div>
        <ol id="plan">
          {d.devWalletId ? <PlanRow {...rowProps(d.devWalletId, 0, true)} /> : <li className="px-4 py-3 text-[12.5px] text-warn">Elige la wallet dev en el paso 2.</li>}
          {buysAfterCreate(d) && d.plan.map((id, i) => <PlanRow key={id} {...rowProps(id, i)} />)}
          {buysAfterCreate(d) && d.plan.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-muted">Añade wallets holder al plan.</li>}
        </ol>
      </div>

      <div id="funding" className="mt-5 flex items-center justify-between gap-4">
        <p className="text-[12.5px] text-muted">{toSend > 0n ? "La dispersión se hace con vista previa de fees y queda en el registro." : "Todas las wallets del plan tienen saldo suficiente (el dry-run lo confirma)."}</p>
        <button onClick={() => setFunding(true)} disabled={toSend <= 0n || funders.length === 0} className="cta h-10 px-4 text-[13px] font-medium">
          Financiar desde el funder
        </button>
      </div>

      {funding && (
        <DisperseDialog
          funders={funders}
          targets={shortList.map((n) => byId.get(n.walletId)!).filter(Boolean)}
          defaultAmount={(Number(maxShort) / 1e9 + 0.0005).toFixed(4).replace(".", ",")}
          exactAmounts={Object.fromEntries(shortList.map((n) => [n.walletId, ((n.short + 99_999n) / 100_000n) * 100_000n]))}
          onClose={() => setFunding(false)}
          onDone={() => void refresh()}
        />
      )}
    </div>
  );
}
