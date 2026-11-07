"use client";

// Borrador del asistente de lanzamiento. Se autoguarda en la API local (REQ-LAUNCH-004);
// el lanzamiento real lo prepara y ejecuta la API local con el draftId de este borrador.
import { create } from "zustand";
import { api } from "@/lib/api";

export type UploadState = { status: "idle" | "uploading" | "done" | "error"; progress: number; cid?: string; error?: string };
export type SaveState = "unsaved" | "saving" | "saved" | "error";

export type Draft = {
  draftId: string;
  name: string;
  symbol: string;
  description: string;
  /** vista previa local (data URL si es pequeña) */
  image?: { name: string; size: number; type: string; url: string };
  upload: UploadState;
  links: { x: string; telegram: string; web: string };
  mode: "classic" | "mayhem";
  feeMode: "creator" | "holders";
  feeAck: boolean;
  devWalletId: string;
  devBuy: string;
  /** quick: compras seguidas tras crear · pro: con espera fija por wallet · manual: solo dev */
  launchMode: "quick" | "pro" | "manual";
  amountMode: "fixed" | "range";
  fixedAmount: string;
  rangeMin: string;
  rangeMax: string;
  slippage: string;
  /** wallets holder del plan, en orden de compra */
  plan: string[];
  /** Modo Pro: segundos de espera antes de la compra de cada wallet (por id), desde la compra anterior */
  delays: Record<string, string>;
  /** REQ-LAUNCH-014: Launch Guard (solo modo Quick) */
  guardEnabled: boolean;
  guardSol: string;
  guardSec: string;
  guardWhitelist: string;
};

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const emptyDraft = (): Draft => ({
  draftId: newId(),
  name: "",
  symbol: "",
  description: "",
  upload: { status: "idle", progress: 0 },
  links: { x: "", telegram: "", web: "" },
  mode: "classic",
  feeMode: "creator",
  feeAck: false,
  devWalletId: "",
  devBuy: "0,5",
  launchMode: "quick",
  amountMode: "fixed",
  fixedAmount: "0,2",
  rangeMin: "0,15",
  rangeMax: "0,3",
  slippage: "15",
  plan: [],
  delays: {},
  guardEnabled: false,
  guardSol: "1",
  guardSec: "30",
  guardWhitelist: "",
});

export const num = (s: string) => {
  const v = Number(String(s).replace(",", "."));
  return Number.isFinite(v) ? v : NaN;
};
export const toLamports = (s: string) => {
  const v = num(s);
  return Number.isNaN(v) || v < 0 ? 0n : BigInt(Math.round(v * 1e9));
};

/** Monto de cada holder del plan (determinista dentro del rango para que la vista previa sea estable). */
/** Quick y Pro compran con las wallets del plan tras crear el token. */
export const buysAfterCreate = (d: Pick<Draft, "launchMode">) => d.launchMode !== "manual";

/** Espera (s) antes de la compra de una wallet; solo cuenta en Pro. NaN si el texto no es válido. */
export function delayOf(d: Pick<Draft, "launchMode" | "delays">, id: string): number {
  if (d.launchMode !== "pro") return 0;
  const raw = (d.delays?.[id] ?? "").trim();
  if (raw === "") return 0;
  const v = Number(raw.replace(",", "."));
  return Number.isInteger(v) && v >= 0 && v <= 600 ? v : NaN;
}

/** Segundos acumulados de espera hasta cada compra del plan (sin contar las confirmaciones). */
export const delayTimeline = (d: Draft) => {
  let acc = 0;
  return d.plan.map((id) => (acc += delayOf(d, id) || 0));
};

export function planAmounts(d: Draft): bigint[] {
  if (d.launchMode === "manual") return [];
  if (d.amountMode === "fixed") return d.plan.map(() => toLamports(d.fixedAmount));
  const lo = toLamports(d.rangeMin);
  const hi = toLamports(d.rangeMax);
  return d.plan.map((_, i) => lo + ((hi - lo) * BigInt((i * 37) % 100)) / 100n);
}

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
  if (buysAfterCreate(d) && d.guardEnabled) {
    const g = num(d.guardSol);
    if (Number.isNaN(g) || g <= 0) e.guardSol = "Indica un umbral mayor que 0.";
    const sec = Number(d.guardSec);
    if (!Number.isInteger(sec) || sec < 1 || sec > 3600) e.guardSec = "Entre 1 y 3.600 segundos.";
    const bad = guardList(d).find((a) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
    if (bad) e.guardWhitelist = `Dirección no válida: ${bad.slice(0, 12)}…`;
  }
  const slip = num(d.slippage);
  if (Number.isNaN(slip) || slip < 0.1 || slip > 50) e.slippage = "Entre 0,1 % y 50 %.";
  if (d.launchMode === "pro" && d.plan.some((id) => Number.isNaN(delayOf(d, id)))) e.delays = "Espera: segundos enteros entre 0 y 600.";
  if (buysAfterCreate(d)) {
    if (d.amountMode === "fixed") {
      const a = num(d.fixedAmount);
      if (Number.isNaN(a) || a <= 0) e.fixedAmount = "Indica un monto mayor que 0.";
    } else {
      const lo = num(d.rangeMin);
      const hi = num(d.rangeMax);
      if (Number.isNaN(lo) || Number.isNaN(hi) || lo <= 0 || hi < lo) e.range = "El máximo debe ser mayor o igual que el mínimo, y ambos > 0.";
    }
  }
  return e;
}

/** Margen que necesita cada wallet además de su compra: fee de red + cuenta de token (estimado, el dry-run lo confirma). */
export const HOLDER_BUFFER = 3_500_000n;
/** La wallet dev paga la creación: cuentas del mint y de la curva (estimado) + fees. */
export const DEV_BUFFER = 30_000_000n;

export function issues(d: Draft, ctx: { balances: Record<string, bigint>; addressOf: (id: string) => string | undefined }): Issue[] {
  const out: Issue[] = [];
  const fe = fieldErrors(d);
  if (!d.name.trim()) out.push({ id: "name", step: 1, field: "name", message: "Falta el nombre del token." });
  if (!d.symbol) out.push({ id: "symbol", step: 1, field: "symbol", message: "Falta el símbolo." });
  if (!d.image) out.push({ id: "image", step: 1, field: "image", message: "Falta la imagen o el vídeo." });
  else if (d.upload.status === "uploading") out.push({ id: "upload", step: 1, field: "image", message: "La subida no ha terminado." });
  else if (d.upload.status === "error") out.push({ id: "upload", step: 1, field: "image", message: "La subida falló. Vuelve a subir." });
  else if (d.upload.status !== "done") out.push({ id: "upload", step: 1, field: "image", message: "Sube la imagen." });
  for (const [k, v] of Object.entries(fe)) {
    if (!v) continue;
    out.push({ id: `fe-${k}`, step: ["name", "symbol", "description", "x", "telegram", "web"].includes(k) ? 1 : k === "delays" ? 3 : 2, field: k, message: v });
  }
  if (!d.devWalletId) out.push({ id: "dev", step: 2, field: "devWallet", message: "Elige la wallet dev." });
  if (!d.feeAck) out.push({ id: "feeAck", step: 2, field: "feeAck", message: "Confirma el destino de las comisiones (irreversible)." });
  if (buysAfterCreate(d) && d.plan.length === 0) out.push({ id: "plan", step: 3, field: "plan", message: "Añade al menos una wallet holder o usa el modo Manual." });
  const short = fundingNeeds(d, ctx).filter((n) => n.short > 0n).length;
  if (short > 0) out.push({ id: "funding", step: 3, field: "funding", message: `${short} wallets sin saldo suficiente. Financia desde el funder.` });
  return out;
}

export function fundingNeeds(d: Draft, ctx: { balances: Record<string, bigint>; addressOf: (id: string) => string | undefined }) {
  const out: { walletId: string; need: bigint; have: bigint; short: bigint; dev: boolean }[] = [];
  if (d.devWalletId) {
    const a = ctx.addressOf(d.devWalletId);
    const need = toLamports(d.devBuy) + DEV_BUFFER;
    const have = a ? (ctx.balances[a] ?? 0n) : 0n;
    out.push({ walletId: d.devWalletId, need, have, short: need > have ? need - have : 0n, dev: true });
  }
  planAmounts(d).forEach((l, i) => {
    const id = d.plan[i];
    const a = ctx.addressOf(id);
    const need = l + HOLDER_BUFFER;
    const have = a ? (ctx.balances[a] ?? 0n) : 0n;
    out.push({ walletId: id, need, have, short: need > have ? need - have : 0n, dev: false });
  });
  return out;
}

export const guardList = (d: Draft) => d.guardWhitelist.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

/** Configuración que se envía al dry-run del servidor. */
export function toConfig(d: Draft) {
  const amounts = planAmounts(d);
  return {
    draftId: d.draftId,
    name: d.name.trim(),
    symbol: d.symbol,
    description: d.description,
    imageCid: d.upload.cid ?? "",
    links: d.links,
    devWalletId: d.devWalletId,
    devBuyLamports: toLamports(d.devBuy).toString(),
    mode: d.launchMode,
    holders: buysAfterCreate(d) ? d.plan.map((id, i) => ({ walletId: id, lamports: amounts[i].toString(), delaySec: delayOf(d, id) || 0 })) : [],
    slippagePct: num(d.slippage),
    mayhem: d.mode === "mayhem",
    feeMode: d.feeMode,
    feeAck: d.feeAck,
    guard: buysAfterCreate(d) && d.guardEnabled ? { thresholdLamports: toLamports(d.guardSol).toString(), windowSec: Number(d.guardSec), whitelist: guardList(d) } : null,
  };
}

// ── Store con autoguardado en la API local (REQ-LAUNCH-004) ───────────
// El borrador vive en SQLite: sobrevive a reinicios, a otro navegador y se retoma desde /launches/drafts.
const LEGACY_KEY = "nebula.draft.v2";

type DraftStore = {
  draft: Draft;
  save: SaveState;
  hydrated: boolean;
  /** Carga el borrador `id`; sin id, retoma el último sin lanzar o empieza uno nuevo (`fresh`). */
  hydrate: (id?: string | null, fresh?: boolean) => Promise<void>;
  set: (patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => void;
  /** Descarta el borrador actual en el servidor y empieza uno nuevo. */
  reset: () => Promise<void>;
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let loadSeq = 0;

const revive = (data: Partial<Draft>, id: string): Draft => {
  // Una subida en curso no sobrevive a un cierre
  const upload = data.upload?.status === "uploading" ? { status: "idle" as const, progress: 0 } : data.upload;
  return { ...emptyDraft(), ...data, draftId: id, upload: upload ?? { status: "idle", progress: 0 } };
};

/** Lo que se guarda: la vista previa solo si es una imagen pequeña (un vídeo se vuelve a elegir). */
const persistable = (d: Draft) => ({ ...d, image: d.image && d.image.url.length < 1_500_000 ? d.image : d.image ? { ...d.image, url: "" } : undefined });

async function migrateLegacy() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {}
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (parsed.draftId) await api(`/drafts/${parsed.draftId}`, { method: "PUT", body: parsed });
    localStorage.removeItem(LEGACY_KEY);
  } catch {}
}

export const useDraft = create<DraftStore>((set, get) => ({
  draft: emptyDraft(),
  save: "saved",
  hydrated: false,
  hydrate: async (id, fresh) => {
    const seq = ++loadSeq;
    clearTimeout(saveTimer);
    set({ hydrated: false });
    await migrateLegacy();
    let next: Draft = emptyDraft();
    try {
      if (id) {
        const r = await api<{ id: string; data: Partial<Draft> }>(`/drafts/${id}`);
        next = revive(r.data, r.id);
      } else if (!fresh) {
        const r = await api<{ draft: { id: string } | null }>("/drafts/latest");
        if (r.draft) next = revive((await api<{ id: string; data: Partial<Draft> }>(`/drafts/${r.draft.id}`)).data, r.draft.id);
      }
    } catch {
      // borrador inexistente o API caída: se empieza uno nuevo (nada se pierde: el anterior sigue en el servidor)
    }
    if (seq === loadSeq) set({ draft: next, hydrated: true, save: "saved" });
  },
  set: (patch) => {
    const next = { ...get().draft, ...(typeof patch === "function" ? patch(get().draft) : patch) };
    set({ draft: next, save: "unsaved" });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const d = get().draft;
      set({ save: "saving" });
      try {
        await api(`/drafts/${d.draftId}`, { method: "PUT", body: persistable(d) });
        if (get().draft.draftId === d.draftId) set((st) => ({ save: st.draft === d ? "saved" : st.save }));
      } catch {
        set({ save: "error" });
      }
    }, 500);
  },
  reset: async () => {
    clearTimeout(saveTimer);
    const id = get().draft.draftId;
    await api(`/drafts/${id}`, { method: "DELETE" }).catch(() => {});
    set({ draft: emptyDraft(), save: "saved" });
  },
}));
