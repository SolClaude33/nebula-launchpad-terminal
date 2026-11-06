"use client";

// Borrador del asistente de lanzamiento (prototipo F0). En F1 se persiste en SQLite
// vía la API local; aquí se autoguarda en localStorage para demostrar REQ-LAUNCH-004.
import { create } from "zustand";
import { ATA_RENT, BASE_FEE, PRIORITY_FEE, SOL_USD } from "@/lib/sim";

export type IpfsState = { status: "idle" | "uploading" | "done" | "error"; progress: number; cid?: string; error?: string };
export type PlanWallet = { id: string; label: string; address: string; balance: number; amount: number };
export type SaveState = "unsaved" | "saving" | "saved" | "error";
export type DryRow = { label: string; kind: "create" | "buy"; ok: boolean; reason?: string; units: number };

export type Draft = {
  name: string;
  symbol: string;
  description: string;
  image?: { name: string; size: number; type: string; url: string };
  ipfs: IpfsState;
  failNextUpload: boolean;
  links: { x: string; telegram: string; web: string };
  mode: "classic" | "mayhem";
  feeMode: "creator" | "holders";
  feeAck: boolean;
  devBuy: string;
  launchMode: "quick" | "manual";
  amountMode: "fixed" | "range";
  fixedAmount: string;
  rangeMin: string;
  rangeMax: string;
  slippage: string;
  priorityFee: string;
  jitoTip: string;
  schedule: "now" | "at";
  launchAt: string;
  guard: { enabled: boolean; thresholdSol: string; timeoutSec: string; whitelist: string };
  plan: PlanWallet[];
  devBalance: number;
};

export const FUNDER_BALANCE = 24.812;

const DEV: PlanWallet = { id: "dev", label: "Dev", address: "D3vkq8GfNpEo7Ha2xYbW1sLzR5tUcM9jKi4VnB6pQeXw", balance: 0.84, amount: 0 };
const HOLDERS: PlanWallet[] = Array.from({ length: 8 }, (_, i) => ({
  id: `h${i + 1}`,
  label: `Holder ${String(i + 1).padStart(2, "0")}`,
  address: ["7Hq2", "9xPa", "3MvR", "BkT8", "5yWc", "Fz1N", "Ce6L", "8dJu"][i] + "Lp9wQe4RtYuZx2Vb6Nm3Kj8Hg5Fd1Sa7",
  balance: [0.42, 0.18, 0.31, 0.06, 0.27, 0.12, 0.35, 0.09][i],
  amount: 0.2,
}));

export const emptyDraft = (): Draft => ({
  name: "",
  symbol: "",
  description: "",
  ipfs: { status: "idle", progress: 0 },
  failNextUpload: false,
  links: { x: "", telegram: "", web: "" },
  mode: "classic",
  feeMode: "creator",
  feeAck: false,
  devBuy: "0,5",
  launchMode: "quick",
  amountMode: "fixed",
  fixedAmount: "0,2",
  rangeMin: "0,15",
  rangeMax: "0,3",
  slippage: "15",
  priorityFee: "0,0001",
  jitoTip: "0,001",
  schedule: "now",
  launchAt: "",
  guard: { enabled: false, thresholdSol: "5", timeoutSec: "30", whitelist: "" },
  plan: HOLDERS.slice(0, 5),
  devBalance: DEV.balance,
});

export const ALL_HOLDERS = HOLDERS;
export const DEV_WALLET = DEV;
export const num = (s: string) => {
  const v = Number(String(s).replace(",", "."));
  return Number.isFinite(v) ? v : NaN;
};

// ── Validación ─────────────────────────────────────────────────────
export type Issue = { id: string; step: 1 | 2 | 3 | 4; field: string; message: string };

const urlOk = (v: string, hosts?: string[]) => {
  if (!v) return true;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return hosts ? hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) : true;
  } catch {
    return false;
  }
};

export function fieldErrors(d: Draft) {
  const e: Record<string, string | undefined> = {};
  if (d.name && d.name.trim().length > 32) e.name = "Máximo 32 caracteres.";
  if (d.symbol && !/^[A-Z0-9]{1,10}$/.test(d.symbol)) e.symbol = "De 1 a 10 caracteres: letras A–Z y dígitos.";
  if (d.description.length > 500) e.description = "Máximo 500 caracteres.";
  if (!urlOk(d.links.x, ["x.com", "twitter.com"])) e.x = "URL completa de x.com, p. ej. https://x.com/tu_token";
  if (!urlOk(d.links.telegram, ["t.me", "telegram.me"])) e.telegram = "URL completa de t.me, p. ej. https://t.me/tu_grupo";
  if (!urlOk(d.links.web)) e.web = "URL completa, con https://";
  const dev = num(d.devBuy);
  if (Number.isNaN(dev) || dev < 0) e.devBuy = "Indica un número ≥ 0.";
  else if (dev > 50) e.devBuy = "Máximo 50 SOL en el prototipo.";
  const slip = num(d.slippage);
  if (Number.isNaN(slip) || slip <= 0 || slip > 50) e.slippage = "Entre 0,1 % y 50 %.";
  if (d.launchMode === "quick") {
    if (d.amountMode === "fixed") {
      const a = num(d.fixedAmount);
      if (Number.isNaN(a) || a <= 0) e.fixedAmount = "Indica un monto mayor que 0.";
    } else {
      const lo = num(d.rangeMin);
      const hi = num(d.rangeMax);
      if (Number.isNaN(lo) || Number.isNaN(hi) || lo <= 0 || hi < lo) e.range = "El máximo debe ser mayor o igual que el mínimo, y ambos > 0.";
    }
  }
  if (d.schedule === "at") {
    const t = Date.parse(d.launchAt);
    if (!d.launchAt || Number.isNaN(t)) e.launchAt = "Elige fecha y hora.";
    else if (t < Date.now() + 60_000) e.launchAt = "Debe ser al menos 1 minuto en el futuro.";
  }
  if (d.guard.enabled) {
    const th = num(d.guard.thresholdSol);
    const to = num(d.guard.timeoutSec);
    if (Number.isNaN(th) || th <= 0) e.guardThreshold = "Umbral > 0 SOL.";
    if (Number.isNaN(to) || to < 1) e.guardTimeout = "Mínimo 1 s.";
  }
  return e;
}

export function walletNeeds(d: Draft) {
  const fee = BASE_FEE + PRIORITY_FEE + ATA_RENT + 0.002;
  const amounts = planAmounts(d);
  return d.plan.map((w, i) => {
    const need = amounts[i] + fee;
    return { ...w, need, short: Math.max(0, need - w.balance) };
  });
}

export function planAmounts(d: Draft) {
  if (d.launchMode === "manual") return d.plan.map(() => 0);
  if (d.amountMode === "fixed") return d.plan.map(() => num(d.fixedAmount) || 0);
  const lo = num(d.rangeMin) || 0;
  const hi = num(d.rangeMax) || lo;
  // Distribución determinista dentro del rango para que la vista previa sea estable
  return d.plan.map((_, i) => +(lo + ((hi - lo) * ((i * 37) % 100)) / 100).toFixed(3));
}

export function issues(d: Draft): Issue[] {
  const out: Issue[] = [];
  const fe = fieldErrors(d);
  if (!d.name.trim()) out.push({ id: "name", step: 1, field: "name", message: "Falta el nombre del token." });
  if (!d.symbol) out.push({ id: "symbol", step: 1, field: "symbol", message: "Falta el símbolo." });
  if (!d.image) out.push({ id: "image", step: 1, field: "image", message: "Falta la imagen o el vídeo." });
  else if (d.ipfs.status === "uploading") out.push({ id: "ipfs", step: 1, field: "image", message: "La subida a IPFS no ha terminado." });
  else if (d.ipfs.status === "error") out.push({ id: "ipfs", step: 1, field: "image", message: "La subida a IPFS falló. Vuelve a subir." });
  else if (d.ipfs.status !== "done") out.push({ id: "ipfs", step: 1, field: "image", message: "Sube los metadatos a IPFS." });
  for (const [k, v] of Object.entries(fe)) {
    if (!v) continue;
    const step = ["name", "symbol", "description", "x", "telegram", "web"].includes(k) ? 1 : 2;
    out.push({ id: `fe-${k}`, step, field: k, message: v });
  }
  if (!d.feeAck) out.push({ id: "feeAck", step: 2, field: "feeAck", message: "Confirma el destino de las comisiones (irreversible)." });
  if (d.launchMode === "quick" && d.plan.length === 0) out.push({ id: "plan", step: 3, field: "plan", message: "Añade al menos una wallet holder o usa el modo Manual." });
  const short = walletNeeds(d).filter((w) => w.short > 0).length;
  const devShort = devNeed(d) > d.devBalance;
  if (short > 0 || devShort) out.push({ id: "funding", step: 3, field: "funding", message: `${short + (devShort ? 1 : 0)} wallets sin saldo suficiente. Financia desde el funder.` });
  return out;
}

/** La wallet dev paga creación (rent del mint), dev buy, propina Jito y fees. */
export function devNeed(d: Draft) {
  return (num(d.devBuy) || 0) + CURVE_MINT_RENT + ATA_RENT + (num(d.jitoTip) || 0) + BASE_FEE + (num(d.priorityFee) || 0) + 0.001;
}
const CURVE_MINT_RENT = 0.0218;

// ── Estimaciones (REQ-LAUNCH-011) ──────────────────────────────────
// Curva de constante producto con reservas virtuales de demostración; en F1 las da el adaptador.
export const CURVE = { vSol: 30, vTokens: 1_073_000_000, supply: 1_000_000_000, gradMc: 69_000, padFeePct: 1, mintRent: 0.0218 };

export function estimates(d: Draft) {
  let vS = CURVE.vSol;
  let vT = CURVE.vTokens;
  const k = vS * vT;
  const buy = (sol: number) => {
    const inNet = sol * (1 - CURVE.padFeePct / 100);
    const nvS = vS + inNet;
    const nvT = k / nvS;
    const out = vT - nvT;
    vS = nvS;
    vT = nvT;
    return out;
  };
  const dev = Math.max(0, num(d.devBuy) || 0);
  const devTokens = buy(dev);
  const amounts = planAmounts(d);
  const holderTokens = amounts.reduce((a, s) => a + buy(s), 0);
  const holdersSol = amounts.reduce((a, s) => a + s, 0);
  const priceSol = vS / vT;
  const mcUsd = priceSol * CURVE.supply * SOL_USD;
  const txs = 1 + amounts.filter((a) => a > 0).length;
  const network = txs * BASE_FEE;
  const priority = txs * (num(d.priorityFee) || 0);
  const jito = num(d.jitoTip) || 0;
  const pad = ((dev + holdersSol) * CURVE.padFeePct) / 100;
  const rent = CURVE.mintRent + ATA_RENT * (1 + amounts.filter((a) => a > 0).length);
  const buffer = (dev + holdersSol) * 0.02;
  const total = dev + holdersSol + network + priority + jito + rent + buffer;
  const maxLoss = dev + holdersSol + network + priority + jito; // si el precio llega a 0; el rent se recupera
  return {
    dev,
    holdersSol,
    devPct: (devTokens / CURVE.supply) * 100,
    holdersPct: (holderTokens / CURVE.supply) * 100,
    mcUsd,
    gradPct: Math.min(100, (mcUsd / CURVE.gradMc) * 100),
    network,
    priority,
    jito,
    pad,
    rent,
    buffer,
    total,
    maxLoss,
    txs,
  };
}

// ── Store con autoguardado ─────────────────────────────────────────
const KEY = "nebula.draft.v1";

type DraftStore = {
  draft: Draft;
  save: SaveState;
  savedAt?: number;
  hydrated: boolean;
  hydrate: () => void;
  set: (patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => void;
  reset: () => void;
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export const useDraft = create<DraftStore>((set, get) => ({
  draft: emptyDraft(),
  save: "saved",
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Draft>;
        // Una subida en curso no sobrevive a un cierre: vuelve a "idle"
        const ipfs = parsed.ipfs?.status === "uploading" ? { status: "idle" as const, progress: 0 } : parsed.ipfs;
        set({ draft: { ...emptyDraft(), ...parsed, ipfs: ipfs ?? { status: "idle", progress: 0 } }, hydrated: true, save: "saved", savedAt: Date.now() });
        return;
      }
    } catch {}
    set({ hydrated: true });
  },
  set: (patch) => {
    const next = { ...get().draft, ...(typeof patch === "function" ? patch(get().draft) : patch) };
    set({ draft: next, save: "unsaved" });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      set({ save: "saving" });
      setTimeout(() => {
        try {
          const d = get().draft;
          // La imagen solo se guarda si cabe como data URL pequeña
          const persist = { ...d, image: d.image && d.image.url.length < 1_500_000 ? d.image : undefined };
          localStorage.setItem(KEY, JSON.stringify(persist));
          set({ save: "saved", savedAt: Date.now() });
        } catch {
          set({ save: "error" });
        }
      }, 280);
    }, 500);
  },
  reset: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {}
    set({ draft: emptyDraft(), save: "saved" });
  },
}));
