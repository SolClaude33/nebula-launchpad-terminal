"use client";

// Crear o editar (en pausa) una automatización: DCA o límite por market cap en USD (REQ-AUTO-001/002/005/010).
// La validación es la misma que la del servidor (`AutomationConfig` de @nebula/shared) y el plan del DCA se
// muestra antes de guardar: rango = rampa fija del mínimo al máximo, sin aleatoriedad.
import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Bookmark, Bot, Loader2, Plus, Trash2, X } from "lucide-react";
import { AUTO_DEFAULT_MAX_ERRORS, AUTO_DEFAULT_SLIPPAGE, AutomationConfig, dcaPlan, ladderTargets, trailingStopUsd, type DcaConfig } from "@nebula/shared";
import type { FolderDto, WalletDto } from "@nebula/shared";
import { api, ApiError } from "@/lib/api";
import { saveAutomation, fmtDuration, type AutoView } from "@/lib/automations";
import { fmtNum, fmtSol, fmtTokens, fmtUsd, shortAddr } from "@/lib/format";
import { toast } from "@/lib/toast";
import { listPresets, savePreset, type Preset } from "@/lib/presets";

const DECIMALS = 6; // Pump.fun
type Unit = "s" | "min" | "h" | "d";
const UNIT: Record<Unit, number> = { s: 1, min: 60, h: 3600, d: 86400 };
const num = (v: string) => Number(v.replace(",", "."));
const toUnits = (v: string, decimals: number) => {
  const n = num(v);
  return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 10 ** decimals)).toString() : "0";
};
const fromUnits = (v: string | null | undefined, decimals: number) => (v ? String(Number(v) / 10 ** decimals).replace(".", ",") : "");
const splitSec = (sec: number | null | undefined, fallback: [string, Unit]): [string, Unit] => {
  if (!sec) return fallback;
  for (const u of ["d", "h", "min"] as Unit[]) if (sec % UNIT[u] === 0) return [String(sec / UNIT[u]), u];
  return [String(sec), "s"];
};

type Target = { mc: string; amount: string };

/**
 * REQ-AUTO-009: cargar un preset vuelve a montar el formulario con sus valores (sin el mint, que se conserva),
 * reutilizando la misma lógica que rellena el formulario al editar.
 */
export function AutomationForm(props: { initial?: AutoView | null; mint?: string | null; onClose: () => void; onSaved: (v: AutoView) => void }) {
  const [seed, setSeed] = useState<{ key: number; config: AutomationConfig } | null>(null);
  return <AutomationFormInner key={seed?.key ?? 0} {...props} seed={seed?.config ?? null} onPreset={(config) => setSeed((s) => ({ key: (s?.key ?? 0) + 1, config }))} />;
}

function AutomationFormInner({ initial, mint: presetMint, onClose, onSaved, seed, onPreset }: { initial?: AutoView | null; mint?: string | null; onClose: () => void; onSaved: (v: AutoView) => void; seed: AutomationConfig | null; onPreset: (c: AutomationConfig) => void }) {
  const editing = !!initial;
  const c0 = initial?.config ?? seed ?? undefined;
  const [type, setType] = useState<"dca" | "limit" | "trailing">(c0?.type ?? "dca");
  const [side, setSide] = useState<"buy" | "sell">(c0?.side ?? "buy");
  const [mint, setMint] = useState(c0?.mint ?? presetMint ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [wallets, setWallets] = useState<WalletDto[]>([]);
  const [folders, setFolders] = useState<FolderDto[]>([]);
  const [launches, setLaunches] = useState<{ mint: string; symbol: string }[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set(c0?.walletIds ?? []));
  const [includeDev, setIncludeDev] = useState(c0?.includeDev ?? false);
  // DCA
  const dca = c0?.type === "dca" ? c0 : null;
  const dec = side === "buy" ? 9 : DECIMALS;
  const [amountKind, setAmountKind] = useState<"fixed" | "range">(dca?.amount.kind ?? "fixed");
  const [each, setEach] = useState(dca?.amount.kind === "fixed" ? fromUnits(dca.amount.each, dca.side === "buy" ? 9 : DECIMALS) : "0,05");
  const [min, setMin] = useState(dca?.amount.kind === "range" ? fromUnits(dca.amount.min, dca.side === "buy" ? 9 : DECIMALS) : "0,02");
  const [max, setMax] = useState(dca?.amount.kind === "range" ? fromUnits(dca.amount.max, dca.side === "buy" ? 9 : DECIMALS) : "0,05");
  const [interval, setIntervalV] = useState<[string, Unit]>(splitSec(dca?.intervalSec, ["1", "min"]));
  const [endKind, setEndKind] = useState<"amount" | "duration" | "first">(dca?.end.kind ?? "first");
  const [total, setTotal] = useState(dca?.end.totalAmount ? fromUnits(dca.end.totalAmount, dca.side === "buy" ? 9 : DECIMALS) : "0,5");
  const [duration, setDuration] = useState<[string, Unit]>(splitSec(dca?.end.durationSec, ["1", "h"]));
  // Límite
  const lim = c0?.type === "limit" ? c0 : null;
  const [targets, setTargets] = useState<Target[]>(lim ? lim.targets.map((t) => ({ mc: String(t.mcUsd), amount: lim.side === "buy" ? fromUnits(t.lamportsEach, 9) : String(t.pct ?? "") })) : [{ mc: "", amount: "" }]);
  const tr = c0?.type === "trailing" ? c0 : null;
  const [expiry, setExpiry] = useState<[string, Unit]>(splitSec(lim?.expirySec ?? tr?.expirySec, ["", "h"]));
  // Ladder (genera objetivos de venta) y trailing stop
  const [ladder, setLadder] = useState({ from: "", to: "", steps: "4", pct: "25" });
  const [trailPct, setTrailPct] = useState(tr ? String(tr.trailPct).replace(".", ",") : "20");
  const [sellPct, setSellPct] = useState(tr ? String(tr.sellPct).replace(".", ",") : "100");
  const [activation, setActivation] = useState(tr?.activationMcUsd ? String(tr.activationMcUsd) : "");
  // Comunes
  const [mcMin, setMcMin] = useState(c0?.mcMinUsd ? String(c0.mcMinUsd) : "");
  const [mcMax, setMcMax] = useState(c0?.mcMaxUsd ? String(c0.mcMaxUsd) : "");
  const [delay, setDelay] = useState<[string, Unit]>(splitSec(c0?.startDelaySec, ["0", "min"]));
  const [slippage, setSlippage] = useState(String(c0?.slippagePct ?? AUTO_DEFAULT_SLIPPAGE).replace(".", ","));
  const [maxErrors, setMaxErrors] = useState(String(c0?.maxErrors ?? AUTO_DEFAULT_MAX_ERRORS));
  const [mode, setMode] = useState<"parallel" | "staggered">(c0?.mode ?? "parallel");
  const [busy, setBusy] = useState<null | "save" | "start">(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  useEffect(() => {
    listPresets("task").then(setPresets, () => {});
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([api<{ wallets: WalletDto[] }>("/wallets"), api<{ folders: FolderDto[] }>("/folders"), api<{ items: { mint: string; symbol: string }[] }>("/launches").catch(() => ({ items: [] }))]).then(
      ([w, f, l]) => {
        if (!alive) return;
        setWallets(w.wallets.filter((x) => x.kind === "wallet" && !x.archived));
        setFolders(f.folders);
        setLaunches(l.items.filter((x) => x.mint));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [busy, onClose]);

  const isDev = (w: WalletDto) => w.role === "dev";
  const toggle = (id: string) => setSel((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const pickFolder = (fid: string) => setSel(new Set(wallets.filter((w) => (fid === "all" || w.folderIds.includes(fid)) && (includeDev || !isDev(w))).map((w) => w.id)));
  const selDev = wallets.filter((w) => sel.has(w.id) && isDev(w));

  const config = useMemo(() => {
    const sec = (v: [string, Unit]) => Math.round(num(v[0]) * UNIT[v[1]]);
    const common = {
      mint: mint.trim(),
      walletIds: [...sel],
      includeDev,
      mcMinUsd: mcMin.trim() ? num(mcMin) : null,
      mcMaxUsd: mcMax.trim() ? num(mcMax) : null,
      startDelaySec: delay[0].trim() ? sec(delay) : 0,
      slippagePct: num(slippage),
      maxErrors: Math.round(num(maxErrors)),
      mode,
    };
    const raw =
      type === "trailing"
        ? { type, side: "sell", ...common, trailPct: num(trailPct), sellPct: num(sellPct), activationMcUsd: activation.trim() ? num(activation) : null, expirySec: expiry[0].trim() ? sec(expiry) : null }
        : type === "dca"
        ? {
            type,
            side,
            ...common,
            amount: amountKind === "fixed" ? { kind: "fixed", each: toUnits(each, dec) } : { kind: "range", min: toUnits(min, dec), max: toUnits(max, dec) },
            intervalSec: sec(interval),
            end: { kind: endKind, totalAmount: endKind !== "duration" ? toUnits(total, dec) : null, durationSec: endKind !== "amount" ? sec(duration) : null },
          }
        : {
            type,
            side,
            ...common,
            targets: targets.map((t) => ({ mcUsd: num(t.mc), lamportsEach: side === "buy" ? toUnits(t.amount, 9) : null, pct: side === "sell" ? num(t.amount) : null })),
            expirySec: expiry[0].trim() ? sec(expiry) : null,
          };
    return AutomationConfig.safeParse(raw);
  }, [type, side, mint, sel, includeDev, mcMin, mcMax, delay, slippage, maxErrors, mode, amountKind, each, min, max, dec, interval, endKind, total, duration, targets, expiry, trailPct, sellPct, activation]);

  const issues = config.success ? [] : [...new Set(config.error.issues.map((i) => i.message))];
  const plan = config.success && config.data.type === "dca" ? dcaPlan(config.data as DcaConfig, config.data.walletIds.length) : null;
  const unitFmt = (v: bigint) => (side === "buy" ? fmtSol(Number(v) / 1e9, 4) : `${fmtTokens(Number(v) / 10 ** DECIMALS)} tokens`);

  const loadPreset = (p: Preset) => {
    // el mint no viaja en el preset: se conserva el del formulario
    onPreset({ ...(p.data as unknown as AutomationConfig), mint: mint.trim() } as AutomationConfig);
    toast({ tone: "info", title: `Preset «${p.name}» cargado`, body: "Revisa el token y las wallets antes de guardar." });
  };
  const saveAsPreset = async () => {
    setTouched(true);
    if (!config.success || !presetName.trim()) return;
    setSavingPreset(true);
    try {
      const same = presets.find((p) => p.name.toLowerCase() === presetName.trim().toLowerCase());
      await savePreset("task", presetName.trim(), config.data as unknown as Record<string, unknown>, same?.id);
      setPresets(await listPresets("task"));
      toast({ tone: "info", title: same ? "Preset actualizado" : "Preset guardado", body: `«${presetName.trim()}» (sin el token: sirve para cualquiera).` });
      setPresetName("");
    } catch (e) {
      toast({ tone: "error", title: "No se pudo guardar el preset", body: (e as ApiError).message });
    }
    setSavingPreset(false);
  };

  const submit = async (start: boolean) => {
    setTouched(true);
    if (!config.success) return;
    setBusy(start ? "start" : "save");
    setServerError(null);
    try {
      let v = await saveAutomation({ id: initial?.id, label: label.trim() || undefined, config: config.data, start: !editing && start });
      if (editing && start && v.status === "PAUSED") v = await api<AutoView>(`/automations/${v.id}/resume`, { method: "POST", body: {} });
      toast({ tone: "buy", title: editing ? "Cambios guardados" : start ? "Automatización iniciada" : "Automatización guardada", body: v.label });
      onSaved(v);
    } catch (e) {
      setServerError((e as ApiError).message);
    }
    setBusy(null);
  };

  const seg = (on: boolean, tone?: "buy" | "sell") => `flex h-8 items-center justify-center gap-1.5 rounded-[6px] px-3 text-[12.5px] font-medium transition-colors ${on ? (tone === "buy" ? "bg-[var(--buy-soft)] text-buy" : tone === "sell" ? "bg-[var(--sell-soft)] text-sell" : "bg-surface-3 text-fg") : "text-muted hover:text-fg"}`;
  const unitSel = (v: [string, Unit], set: (v: [string, Unit]) => void, units: Unit[], id: string, labelText: string, placeholder = "") => (
    <div className="flex gap-1.5">
      <input id={id} aria-label={labelText} inputMode="decimal" value={v[0]} placeholder={placeholder} onChange={(e) => set([e.target.value, v[1]])} className="field num h-9 py-0" />
      <select aria-label={`${labelText}: unidad`} value={v[1]} onChange={(e) => set([v[0], e.target.value as Unit])} className="field h-9 w-[84px] py-0">
        {units.map((u) => (
          <option key={u} value={u}>
            {u === "d" ? "días" : u}
          </option>
        ))}
      </select>
    </div>
  );
  const amountUnit = side === "buy" ? "SOL" : "tokens";

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="auto-form-title" className="fixed inset-0 z-[90] grid place-items-center bg-black/55 backdrop-blur-sm">
      <div className="glass rise flex max-h-[92dvh] w-[720px] max-w-[calc(100vw-32px)] flex-col rounded-[var(--radius-lg)] shadow-[var(--shadow-float)]">
        <div className="flex items-center gap-2 border-b border-line px-5 py-4">
          <Bot className="size-5 text-accent" aria-hidden />
          <h3 id="auto-form-title" className="flex-1 text-[16px] font-semibold">
            {editing ? `Editar «${initial!.label}»` : "Nueva automatización"}
          </h3>
          {editing && initial!.status === "PAUSED" && <span className="chip text-warn">edición en pausa</span>}
          {!editing && presets.length > 0 && (
            <select
              aria-label="Cargar un preset de tarea"
              value=""
              onChange={(e) => {
                const p = presets.find((x) => x.id === e.target.value);
                if (p) loadPreset(p);
              }}
              className="field h-8 w-auto py-0 text-[12px]"
            >
              <option value="">Cargar preset…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button onClick={onClose} disabled={!!busy} aria-label="Cerrar" className="btn btn-ghost size-8 p-0">
            <X className="size-4" />
          </button>
        </div>

        <div className="scroll-thin grid flex-1 grid-cols-1 gap-x-6 gap-y-4 overflow-y-auto px-5 py-4 md:grid-cols-2">
          {/* tipo y lado */}
          <div>
            <p className="mb-1.5 text-[12px] text-muted">Tipo</p>
            <div role="radiogroup" aria-label="Tipo" className="grid grid-cols-3 gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
              {(["dca", "limit", "trailing"] as const).map((t) => (
                <button
                  key={t}
                  role="radio"
                  aria-checked={type === t}
                  disabled={editing}
                  onClick={() => {
                    setType(t);
                    if (t === "trailing") setSide("sell");
                  }}
                  className={seg(type === t)}
                >
                  {t === "dca" ? "DCA" : t === "limit" ? "Orden límite" : "Trailing stop"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[12px] text-muted">Lado</p>
            <div role="radiogroup" aria-label="Lado" className="grid grid-cols-2 gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
              {(["buy", "sell"] as const).map((s) => (
                <button key={s} role="radio" aria-checked={side === s} disabled={editing || (type === "trailing" && s === "buy")} onClick={() => setSide(s)} className={seg(side === s, s)} title={type === "trailing" && s === "buy" ? "El trailing stop solo vende" : undefined}>
                  {s === "buy" ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
                  {s === "buy" ? "Comprar" : "Vender"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="auto-mint" className="mb-1.5 block text-[12px] text-muted">
              Token (mint)
            </label>
            <input id="auto-mint" list="auto-mints" value={mint} disabled={editing} onChange={(e) => setMint(e.target.value)} placeholder="Dirección del token" className="field num h-9 py-0 text-[12.5px]" />
            <datalist id="auto-mints">
              {launches.map((l) => (
                <option key={l.mint} value={l.mint}>
                  ${l.symbol}
                </option>
              ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="auto-label" className="mb-1.5 block text-[12px] text-muted">
              Nombre <span className="text-faint">(opcional)</span>
            </label>
            <input id="auto-label" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder={type === "dca" ? "DCA de compra" : type === "limit" ? "Límite de venta" : "Trailing stop"} className="field h-9 py-0" />
          </div>

          {/* wallets */}
          <fieldset className="md:col-span-2">
            <legend className="mb-1.5 flex w-full items-center gap-2 text-[12px] text-muted">
              Wallets <span className="num text-faint">{sel.size} elegidas</span>
              <select aria-label="Elegir por carpeta" defaultValue="" onChange={(e) => e.target.value && pickFolder(e.target.value)} className="field ml-auto h-7 w-auto py-0 text-[12px]">
                <option value="">Elegir carpeta…</option>
                <option value="all">Todas</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setSel(new Set())} className="btn btn-ghost h-7 px-2 text-[12px]">
                Ninguna
              </button>
            </legend>
            <div className="scroll-thin grid max-h-[148px] grid-cols-2 gap-1 overflow-y-auto rounded-[var(--radius-sm)] border border-line bg-surface-2/40 p-1.5 lg:grid-cols-3">
              {wallets.length === 0 && <p className="col-span-full px-2 py-3 text-[12px] text-faint">Cargando wallets…</p>}
              {wallets.map((w) => {
                const locked = isDev(w) && !includeDev;
                return (
                  <label key={w.id} className={`flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12.5px] ${locked ? "opacity-50" : "cursor-pointer hover:bg-surface-3/60"}`} title={locked ? "La wallet dev queda excluida salvo que la incluyas de forma explícita" : w.address}>
                    <input type="checkbox" aria-label={`${w.label}${isDev(w) ? " (dev)" : ""}`} checked={sel.has(w.id)} disabled={locked} onChange={() => toggle(w.id)} className="size-3.5 accent-[var(--accent-a)]" />
                    <span className="truncate">{w.label}</span>
                    {isDev(w) ? <span className="chip ml-auto h-4 px-1.5 text-[10px] text-warn">dev</span> : <span className="num ml-auto text-[10.5px] text-faint">{shortAddr(w.address, 3, 3)}</span>}
                  </label>
                );
              })}
            </div>
            <label className="mt-2 inline-flex items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                checked={includeDev}
                onChange={(e) => {
                  setIncludeDev(e.target.checked);
                  if (!e.target.checked) setSel((s) => new Set([...s].filter((id) => !wallets.some((w) => w.id === id && isDev(w)))));
                }}
                className="size-3.5 accent-[var(--warn)]"
              />
              Incluir la wallet dev <span className="text-faint">(REQ-AUTO-010: excluida por defecto)</span>
            </label>
            {selDev.length > 0 && <p className="mt-1 text-[12px] text-warn">La tarea incluye la wallet dev ({selDev.map((w) => w.label).join(", ")}): la tarjeta mostrará «incl. dev».</p>}
          </fieldset>

          {type === "dca" ? (
            <>
              <div>
                <p className="mb-1.5 text-[12px] text-muted">Monto por wallet y ejecución ({amountUnit})</p>
                <div className="mb-2 inline-flex gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1" role="radiogroup" aria-label="Monto">
                  {(["fixed", "range"] as const).map((k) => (
                    <button key={k} role="radio" aria-checked={amountKind === k} onClick={() => setAmountKind(k)} className={seg(amountKind === k)}>
                      {k === "fixed" ? "Fijo" : "Rango"}
                    </button>
                  ))}
                </div>
                {amountKind === "fixed" ? (
                  <input aria-label={`Monto fijo en ${amountUnit}`} inputMode="decimal" value={each} onChange={(e) => setEach(e.target.value)} className="field num h-9 py-0" />
                ) : (
                  <div className="flex items-center gap-2">
                    <input aria-label={`Mínimo en ${amountUnit}`} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} className="field num h-9 py-0" />
                    <span className="text-faint">→</span>
                    <input aria-label={`Máximo en ${amountUnit}`} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} className="field num h-9 py-0" />
                  </div>
                )}
                {amountKind === "range" && <p className="mt-1 text-[11.5px] text-faint">Rampa fija del mínimo al máximo en pasos iguales; sin aleatoriedad (§2.3).</p>}
              </div>
              <div>
                <label htmlFor="auto-interval" className="mb-1.5 block text-[12px] text-muted">
                  Cada <span className="text-faint">(máximo 24 h)</span>
                </label>
                {unitSel(interval, setIntervalV, ["s", "min", "h"], "auto-interval", "Intervalo")}
                <p className="mt-3 mb-1.5 text-[12px] text-muted">Termina</p>
                <select aria-label="Condición de fin" value={endKind} onChange={(e) => setEndKind(e.target.value as typeof endKind)} className="field h-9 py-0">
                  <option value="amount">Al llegar a un monto total</option>
                  <option value="duration">Al cumplirse una duración</option>
                  <option value="first">Lo primero que llegue</option>
                </select>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {endKind !== "duration" && <input aria-label={`Monto total en ${amountUnit} (todas las wallets)`} title="Suma de todas las wallets" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder={`Total ${amountUnit}`} className="field num h-9 py-0" />}
                  {endKind !== "amount" && unitSel(duration, setDuration, ["min", "h", "d"], "auto-duration", "Duración")}
                </div>
              </div>
            </>
          ) : type === "trailing" ? (
            <div className="grid grid-cols-2 gap-3 md:col-span-2 md:grid-cols-4">
              <div>
                <label htmlFor="trail-pct" className="mb-1.5 block text-[12px] text-muted">
                  Salta al caer (%)
                </label>
                <input id="trail-pct" inputMode="decimal" value={trailPct} onChange={(e) => setTrailPct(e.target.value)} className="field num h-9 py-0" />
              </div>
              <div>
                <label htmlFor="trail-sell" className="mb-1.5 block text-[12px] text-muted">
                  Vende (% de la posición)
                </label>
                <input id="trail-sell" inputMode="decimal" value={sellPct} onChange={(e) => setSellPct(e.target.value)} className="field num h-9 py-0" />
              </div>
              <div>
                <label htmlFor="trail-act" className="mb-1.5 block text-[12px] text-muted">
                  Se activa en MC ≥ $ <span className="text-faint">(opcional)</span>
                </label>
                <input id="trail-act" inputMode="decimal" value={activation} onChange={(e) => setActivation(e.target.value)} placeholder="ya" className="field num h-9 py-0" />
              </div>
              <div>
                <label htmlFor="auto-expiry" className="mb-1.5 block text-[12px] text-muted">
                  Validez <span className="text-faint">(vacío = sin caducidad)</span>
                </label>
                {unitSel(expiry, setExpiry, ["h", "d"], "auto-expiry", "Validez", "—")}
              </div>
              <p className="col-span-full text-[11.5px] text-faint">
                Sigue el máximo del market cap (USD) desde la activación y vende una sola vez cuando cae el % indicado desde ese máximo
                {num(trailPct) > 0 && num(trailPct) < 100 ? ` (con un máximo de $100.000, saltaría a ${fmtUsd(trailingStopUsd(100_000, num(trailPct)))})` : ""}. Pausar o parar nunca vende.
              </p>
            </div>
          ) : (
            <div className="md:col-span-2">
              <p className="mb-1.5 text-[12px] text-muted">
                Objetivos por market cap (USD) · {side === "buy" ? "compras de mayor a menor" : "ventas de menor a mayor"}
              </p>
              {side === "sell" && (
                <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-[var(--radius-sm)] border border-line bg-surface-2/40 px-2.5 py-2 text-[12px] text-muted">
                  <span className="font-medium text-fg">Ladder</span> desde $
                  <input aria-label="Ladder: market cap inicial en USD" inputMode="decimal" value={ladder.from} onChange={(e) => setLadder({ ...ladder, from: e.target.value })} placeholder="50000" className="field num h-7 w-[96px] py-0 text-[12px]" />
                  hasta $
                  <input aria-label="Ladder: market cap final en USD" inputMode="decimal" value={ladder.to} onChange={(e) => setLadder({ ...ladder, to: e.target.value })} placeholder="500000" className="field num h-7 w-[96px] py-0 text-[12px]" />
                  en
                  <input aria-label="Ladder: número de tramos" inputMode="numeric" value={ladder.steps} onChange={(e) => setLadder({ ...ladder, steps: e.target.value })} className="field num h-7 w-[44px] py-0 text-[12px]" />
                  tramos de
                  <input aria-label="Ladder: porcentaje por tramo" inputMode="decimal" value={ladder.pct} onChange={(e) => setLadder({ ...ladder, pct: e.target.value })} className="field num h-7 w-[52px] py-0 text-[12px]" />
                  %
                  <button
                    type="button"
                    onClick={() => {
                      const g = ladderTargets(num(ladder.from), num(ladder.to), Math.round(num(ladder.steps)), num(ladder.pct));
                      if (g.length) setTargets(g.map((x) => ({ mc: String(x.mcUsd), amount: String(x.pct).replace(".", ",") })));
                      else toast({ tone: "warn", title: "Ladder", body: "El market cap final tiene que ser mayor que el inicial." });
                    }}
                    className="btn ml-auto h-7 px-2.5 text-[12px]"
                  >
                    Generar tramos
                  </button>
                </div>
              )}
              <ol className="space-y-1.5">
                {targets.map((t, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="num w-5 text-right text-[12px] text-faint">{i + 1}</span>
                    <span className="text-[12px] whitespace-nowrap text-muted">{side === "buy" ? "MC ≤ $" : "MC ≥ $"}</span>
                    <input aria-label={`Objetivo ${i + 1}: market cap en USD`} inputMode="decimal" value={t.mc} onChange={(e) => setTargets(targets.map((x, j) => (j === i ? { ...x, mc: e.target.value } : x)))} placeholder="50000" className="field num h-9 py-0" />
                    <span className="text-[12px] whitespace-nowrap text-muted">{side === "buy" ? "SOL/wallet" : "% posición"}</span>
                    <input aria-label={`Objetivo ${i + 1}: ${side === "buy" ? "SOL por wallet" : "porcentaje a vender"}`} inputMode="decimal" value={t.amount} onChange={(e) => setTargets(targets.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder={side === "buy" ? "0,1" : "25"} className="field num h-9 w-[110px] py-0" />
                    <button onClick={() => setTargets(targets.filter((_, j) => j !== i))} disabled={targets.length === 1} aria-label={`Quitar objetivo ${i + 1}`} className="btn btn-ghost size-9 shrink-0 p-0">
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ol>
              <div className="mt-2 flex items-center gap-3">
                <button onClick={() => setTargets([...targets, { mc: "", amount: targets.at(-1)?.amount ?? "" }])} disabled={targets.length >= 10} className="btn h-8 px-2.5 text-[12px]">
                  <Plus className="size-3.5" aria-hidden /> Objetivo
                </button>
                <label htmlFor="auto-expiry" className="ml-auto text-[12px] text-muted">
                  Validez <span className="text-faint">(vacío = sin caducidad)</span>
                </label>
                <div className="w-[190px]">{unitSel(expiry, setExpiry, ["h", "d"], "auto-expiry", "Validez", "—")}</div>
              </div>
            </div>
          )}

          {/* opciones comunes (REQ-AUTO-005) */}
          <fieldset className="grid grid-cols-2 gap-3 border-t border-line pt-4 md:col-span-2 md:grid-cols-4">
            <legend className="sr-only">Opciones comunes</legend>
            <div className="col-span-2">
              <p className="mb-1.5 text-[12px] text-muted">
                Rango de market cap (USD) <span className="text-faint">opcional</span>
              </p>
              <div className="flex items-center gap-2">
                <input aria-label="Market cap mínimo en USD" inputMode="decimal" value={mcMin} onChange={(e) => setMcMin(e.target.value)} placeholder="mín." className="field num h-9 py-0" />
                <span className="text-faint">–</span>
                <input aria-label="Market cap máximo en USD" inputMode="decimal" value={mcMax} onChange={(e) => setMcMax(e.target.value)} placeholder="máx." className="field num h-9 py-0" />
              </div>
            </div>
            <div className="col-span-2">
              <label htmlFor="auto-delay" className="mb-1.5 block text-[12px] text-muted">
                Retardo de inicio
              </label>
              {unitSel(delay, setDelay, ["s", "min", "h"], "auto-delay", "Retardo de inicio")}
            </div>
            <div>
              <label htmlFor="auto-slip" className="mb-1.5 block text-[12px] text-muted">
                Slippage máx. %
              </label>
              <input id="auto-slip" inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} className="field num h-9 py-0" />
            </div>
            <div>
              <label htmlFor="auto-errs" className="mb-1.5 block text-[12px] text-muted" title="Ejecuciones seguidas en las que no entra ninguna wallet">
                Parar tras N errores
              </label>
              <input id="auto-errs" inputMode="numeric" value={maxErrors} onChange={(e) => setMaxErrors(e.target.value)} className="field num h-9 py-0" />
            </div>
            <div className="col-span-2">
              <p className="mb-1.5 text-[12px] text-muted">Envío entre wallets</p>
              <div role="radiogroup" aria-label="Envío entre wallets" className="grid grid-cols-2 gap-1 rounded-[var(--radius-sm)] border border-line bg-surface-2/60 p-1">
                {(["parallel", "staggered"] as const).map((m) => (
                  <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={seg(mode === m)}>
                    {m === "parallel" ? "En paralelo" : "Escalonado (800 ms)"}
                  </button>
                ))}
              </div>
            </div>
          </fieldset>

          {/* plan */}
          {plan && config.success && config.data.type === "dca" && (
            <div className="panel reticle md:col-span-2 p-3 text-[12.5px]">
              <p className="telemetry">Plan</p>
              <p className="mt-1">
                {plan.executions !== null ? <span className="num">{fmtNum(plan.executions)} ejecuciones</span> : "Hasta que la pares"} · cada {fmtDuration(config.data.intervalSec)} · {config.data.walletIds.length} wallets ·{" "}
                {config.data.amount.kind === "fixed" ? (
                  <span className="num">{unitFmt(plan.amountAt(0))} por wallet</span>
                ) : (
                  <span className="num">
                    {unitFmt(plan.amountAt(0))} → {unitFmt(plan.amountAt((plan.executions ?? 1) - 1))} por wallet
                  </span>
                )}
                {config.data.end.kind !== "duration" && config.data.end.totalAmount && <span className="num"> · total {unitFmt(BigInt(config.data.end.totalAmount))}</span>}
              </p>
              {side === "sell" && <p className="mt-1 text-[11.5px] text-faint">Cada venta se recorta al saldo de la wallet; sin tokens, la wallet queda omitida.</p>}
            </div>
          )}
          {type === "trailing" && config.success && config.data.type === "trailing" && (
            <p className="text-[12px] text-faint md:col-span-2">Se dispara con el market cap del indexer y el precio SOL/USD de Pyth.</p>
          )}
          {type === "limit" && config.success && config.data.type === "limit" && (
            <p className="text-[12px] text-faint md:col-span-2">
              Se dispara con el market cap del indexer y el precio SOL/USD de Pyth. Cada objetivo se ejecuta una vez, en orden ({config.data.targets.map((t) => fmtUsd(t.mcUsd)).join(" → ")}).
            </p>
          )}
        </div>

        <div className="border-t border-line px-5 py-3">
          {(touched || serverError) && (issues.length > 0 || serverError) && (
            <ul className="mb-2 space-y-0.5 text-[12px] text-sell" role="alert">
              {serverError && <li>{serverError}</li>}
              {touched && issues.slice(0, 4).map((m) => <li key={m}>{m}</li>)}
            </ul>
          )}
          <div className="flex items-center justify-end gap-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void saveAsPreset();
              }}
              className="mr-auto flex items-center gap-1.5"
            >
              <Bookmark className="size-3.5 text-muted" aria-hidden />
              <input aria-label="Nombre del preset de tarea" value={presetName} maxLength={40} onChange={(e) => setPresetName(e.target.value)} placeholder="Guardar como preset…" className="field h-8 w-[170px] py-0 text-[12px]" />
              <button type="submit" disabled={!presetName.trim() || savingPreset} className="btn h-8 px-2.5 text-[12px]">
                {savingPreset ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : "Guardar"}
              </button>
            </form>
            <button onClick={onClose} disabled={!!busy} className="btn h-9 px-4 text-[13px]">
              Cancelar
            </button>
            <button onClick={() => submit(false)} disabled={!!busy} className="btn h-9 px-4 text-[13px]">
              {busy === "save" && <Loader2 className="size-4 animate-spin" aria-hidden />} {editing ? "Guardar cambios" : "Guardar sin iniciar"}
            </button>
            <button onClick={() => submit(true)} disabled={!!busy} className="cta cta-fill flex h-9 items-center gap-2 px-4 text-[13px] font-semibold">
              {busy === "start" && <Loader2 className="size-4 animate-spin" aria-hidden />} {editing ? (initial!.status === "PAUSED" ? "Guardar y reanudar" : "Guardar") : "Guardar e iniciar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
