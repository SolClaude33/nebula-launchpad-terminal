// REQ-LAUNCH-002..017: lanzamiento real en Pump.fun.
// PREPARED (preflight) → CREATING → CREATED → BUYING (Quick) → DONE; PAUSED al bloquear/reiniciar.
// Cada envío lleva su idempotency key: launch:<id>:create y launch:<id>:buy:<walletId>.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Profile } from "@nebula/shared";
import type { DB } from "./db";
import { kvGet, kvSet, logActivity } from "./db";
import type { Vault } from "./signer";
import { VaultError } from "./signer";
import type { ChainManager } from "./chain-manager";
import { assertUriForProfile, type MetadataStore } from "./ipfs";
import { txFee } from "./chain/fees";
import { MAX_BUNDLE_BUYS, bundleTransport } from "./chain/jito";

const url = z.string().trim().max(200).refine((v) => v === "" || /^https?:\/\/\S+$/.test(v), "URL completa, con https://");
export const LaunchConfig = z.object({
  draftId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),
  name: z.string().trim().min(1).max(32),
  symbol: z.string().regex(/^[A-Z0-9]{1,10}$/, "Símbolo: 1-10 caracteres A-Z y 0-9"),
  description: z.string().max(500).default(""),
  imageCid: z.string().min(1),
  links: z.object({ x: url.default(""), telegram: url.default(""), web: url.default("") }).default({ x: "", telegram: "", web: "" }),
  devWalletId: z.string(),
  devBuyLamports: z.string().regex(/^\d+$/),
  /** quick: compras seguidas tras la creación · pro: igual, con una espera fija por wallet · manual: solo dev. */
  mode: z.enum(["quick", "pro", "manual"]),
  /**
   * `delayMs` (solo en Pro): milisegundos fijos entre el envío de la compra anterior y el de esta (la primera,
   * desde la creación confirmada). Las confirmaciones no frenan la siguiente compra. Sin aleatoriedad.
   */
  holders: z.array(z.object({ walletId: z.string(), lamports: z.string().regex(/^\d+$/), delayMs: z.number().int().min(0).max(10_000).default(0) })).max(40).default([]),
  /**
   * Wallets cuya compra va en el bundle atómico con la creación (Jito, máx. 5 tx: la creación ocupa una).
   * `holders` es el snipe: compra después, cuando el bundle ha aterrizado. Una wallet no puede estar en los dos.
   */
  bundle: z.array(z.object({ walletId: z.string().min(1), lamports: z.string().regex(/^\d+$/) })).max(MAX_BUNDLE_BUYS).default([]),
  slippagePct: z.number().min(0.1).max(50),
  mayhem: z.boolean().default(false),
  feeMode: z.enum(["creator", "holders"]),
  feeAck: z.literal(true, { message: "Confirma el destino de las comisiones (irreversible)" }),
  /**
   * REQ-LAUNCH-014 · Launch Guard («Complete Early» del Sniper Guard, sin Nuke): si las compras externas
   * acumuladas desde la creación superan el umbral dentro de la ventana, las compras planificadas que
   * quedan se omiten. Nunca vende. La lista blanca no cuenta como externa.
   */
  guard: z
    .object({
      thresholdLamports: z.string().regex(/^\d+$/),
      windowSec: z.number().int().min(1).max(3600),
      whitelist: z.array(z.string().max(64)).max(50).default([]),
    })
    .nullable()
    .default(null),
}).superRefine((c, ctx) => {
  const msg = launchRoleError(c);
  if (msg) ctx.addIssue({ code: "custom", message: msg });
});
export type LaunchConfig = z.infer<typeof LaunchConfig>;

/** Bundle y snipe son listas distintas. El solapamiento, el dev, el monto 0 y el tope de Jito se rechazan aquí. */
export function launchRoleError(c: { mode: LaunchConfig["mode"]; devWalletId: string; holders: { walletId: string; lamports: string }[]; bundle?: { walletId: string; lamports: string }[] }): string | null {
  const bundle = c.bundle ?? [];
  if (c.mode === "manual" && (bundle.length > 0 || c.holders.length > 0)) return "El modo Manual solo crea el token con el dev buy: no admite wallets de bundle ni de snipe.";
  if (c.mode !== "manual" && bundle.length + c.holders.length === 0) return `El modo ${MODE_LABEL[c.mode]} necesita al menos una wallet en el bundle o en el snipe.`;
  if (bundle.length > MAX_BUNDLE_BUYS) return `Jito admite 5 transacciones por bundle y la creación ocupa una: como máximo ${MAX_BUNDLE_BUYS} compras en el bundle.`;
  const ids = [...bundle.map((b) => b.walletId), ...c.holders.map((h) => h.walletId)];
  if (new Set(ids).size !== ids.length) return "Hay wallets repetidas, o una misma wallet está en el bundle y en el snipe.";
  if (ids.includes(c.devWalletId)) return "La wallet dev ya compra en la creación: no puede estar también en el bundle ni en el snipe.";
  if ([...bundle, ...c.holders].some((x) => BigInt(x.lamports) <= 0n)) return "Cada compra del bundle y del snipe tiene que ser mayor que 0.";
  return null;
}
/** Quick y Pro compran con las wallets del plan tras crear el token; Manual solo crea con el dev buy. */
const buysAfterCreate = (mode: LaunchConfig["mode"]) => mode !== "manual";
const MODE_LABEL: Record<LaunchConfig["mode"], string> = { quick: "Quick", pro: "Pro", manual: "Manual" };

type Status = "PREPARED" | "CREATING" | "CREATED" | "BUYING" | "DONE" | "FAILED" | "PAUSED";
type Row = { id: string; status: Status; paused_from: Status | null; config: string; preflight_fp: string | null; mint: string; create_sig: string | null; error: string | null; created_at: number; updated_at: number; scheduled_at: number | null; schedule_state: "WAITING" | "PAUSED" | "FIRED" | "FAILED" | null; schedule_error: string | null };

/** Margen mínimo para programar y última ventana para cancelar (REQ-LAUNCH-015: «hasta T−10 s»). */
export const SCHEDULE_MIN_LEAD_MS = 20_000;
export const SCHEDULE_CANCEL_CUTOFF_MS = 10_000;
const SCHEDULE_MAX_LEAD_MS = 30 * 86_400_000;
/** REVIEW-F1 P1-2: pasado este retraso (app cerrada o suspendida, RPC caído) no se lanza sin confirmar. */
export const SCHEDULE_GRACE_MS = 2 * 60_000;
/** `note`: dato informativo que no bloquea (p. ej. la propina de Jito de la creación). */
type Check = { label: string; kind: "simulated" | "checked" | "setup"; ok: boolean; reason?: string; note?: string; units?: number; action?: "create-alt" };
type Stored = LaunchConfig & { uri: string; preflight?: { ok: boolean; checks: Check[]; at: number } };

const ATA_BUFFER = 3_000_000n; // cuenta de token (Token-2022) + margen
/**
 * Huella del dry-run: configuración + mint + la propina de Jito vigente. Si Nicol activa Jito o cambia la propina tras
 * un dry-run en verde, el lanzamiento exige volver a simular (nunca se envían costes que no se vieron).
 */
const fp = (c: LaunchConfig, mint: string, tipLamports: bigint) => createHash("sha256").update(JSON.stringify({ ...c, draftId: undefined }) + mint + (tipLamports > 0n ? `|jito:${tipLamports}` : "")).digest("hex");

export class Launches {
  private running = new Set<string>();

  constructor(
    private db: () => DB,
    private chain: ChainManager,
    private vault: Vault,
    readonly store: MetadataStore,
    private profile: Profile,
    private priority: () => number,
    private log: (m: string) => void,
    private clock: () => number = Date.now,
  ) {}

  private scheduler: NodeJS.Timeout | null = null;
  /** Lector de trades del token (el indexer del Live), para el Launch Guard */
  private trades: ((mint: string) => Promise<{ user: string; side: string; lamports: string; ts: number }[]>) | null = null;
  /** Solo para tests: se ejecuta antes de cada compra planificada */
  testHooks: { beforeBuy?: (id: string, ord: number) => Promise<void> } = {};

  attachTrades(fn: (mint: string) => Promise<{ user: string; side: string; lamports: string; ts: number }[]>) {
    this.trades = fn;
  }

  /** Compras externas (ni wallets propias ni lista blanca) desde la creación, en lamports. */
  private async externalBuys(mint: string, whitelist: string[]) {
    if (!this.trades) return 0n;
    const own = new Set((this.db().prepare("SELECT address FROM wallet").all() as { address: string }[]).map((r) => r.address));
    const allow = new Set(whitelist);
    let sum = 0n;
    for (const t of await this.trades(mint)) if (t.side === "buy" && !own.has(t.user) && !allow.has(t.user)) sum += BigInt(t.lamports);
    return sum;
  }
  private firing = new Set<string>();

  private row(id: string) {
    return this.db().prepare("SELECT * FROM launch WHERE id = ?").get(id) as Row | undefined;
  }
  private wallet(id: string) {
    const w = this.db().prepare("SELECT id, label, address, kind FROM wallet WHERE id = ? AND archived = 0").get(id) as { id: string; label: string; address: string; kind: string } | undefined;
    if (!w) throw Object.assign(new Error("Una wallet del plan no existe o está archivada."), { statusCode: 400 });
    return w;
  }

  view(id: string) {
    const r = this.row(id);
    if (!r) throw Object.assign(new Error("Lanzamiento no encontrado"), { statusCode: 404 });
    const cfg = JSON.parse(r.config) as Stored;
    // Momento real de cada envío (tabla tx, por su idempotency key), en ms desde la confirmación de la creación
    const created = this.db().prepare("SELECT updated_at FROM tx WHERE idempotency_key = ? AND status = 'CONFIRMED'").get(`launch:${id}:create`) as { updated_at: number } | undefined;
    const buys = (
      this.db()
        .prepare("SELECT b.ord, b.role, b.wallet_id AS walletId, w.label, b.lamports, b.status, b.tokens, b.signature, b.reason, t.created_at AS sentAt, t.status AS txStatus, t.updated_at AS txUpdatedAt FROM launch_buy b LEFT JOIN wallet w ON w.id = b.wallet_id LEFT JOIN tx t ON t.idempotency_key = 'launch:' || b.launch_id || ':buy:' || b.wallet_id WHERE b.launch_id = ? ORDER BY b.ord")
        .all(id) as { ord: number; role: string; walletId: string; label: string | null; lamports: number; status: string; tokens: string | null; signature: string | null; reason: string | null; sentAt: number | null; txStatus: string | null; txUpdatedAt: number | null }[]
    ).map(({ sentAt, txStatus, txUpdatedAt, ...b }) => ({
      ...b,
      delayMs: cfg.mode === "pro" && b.role !== "bundle" ? (cfg.holders.find((h) => h.walletId === b.walletId)?.delayMs ?? 0) : 0,
      // Envío y confirmación reales, en ms desde la confirmación de la creación; `sentAt` (epoch) para la cuenta en vivo
      sentAt: b.status === "PENDING" && txStatus === "SENT" ? sentAt : null,
      sentAfterMs: created && sentAt !== null ? Math.max(0, sentAt - created.updated_at) : null,
      confirmedAfterMs: created && txStatus === "CONFIRMED" && txUpdatedAt !== null ? Math.max(0, txUpdatedAt - created.updated_at) : null,
    }));
    const scheduled = r.scheduled_at !== null && (r.schedule_state === "WAITING" || r.schedule_state === "PAUSED" || r.schedule_state === "FAILED") && r.status === "PREPARED";
    const bundleResult = JSON.parse(kvGet(this.db(), `launch-bundle:${id}`) ?? "null") as { transport: "simulated" | "block-engine"; bundleId: string | null; status: string; message?: string } | null;
    return { id: r.id, status: r.status, pausedFrom: r.paused_from, mint: r.mint, createSignature: r.create_sig, error: r.error, name: cfg.name, symbol: cfg.symbol, uri: cfg.uri, mode: cfg.mode, preflight: cfg.preflight ?? null, buys, bundleResult, updatedAt: r.updated_at, schedule: scheduled ? { at: r.scheduled_at!, state: r.schedule_state!, error: r.schedule_error, cancellableUntil: r.scheduled_at! - SCHEDULE_CANCEL_CUTOFF_MS } : null };
  }

  /** Lanzamientos ya creados en cadena (para abrir su Live Workspace). */
  list(limit = 50) {
    const rows = this.db().prepare("SELECT id, status, mint, config, created_at, updated_at FROM launch WHERE status IN ('DONE','BUYING','CREATED','PAUSED') ORDER BY created_at DESC LIMIT ?").all(limit) as { id: string; status: string; mint: string; config: string; created_at: number }[];
    return rows.map((r) => {
      const c = JSON.parse(r.config) as Stored;
      return { id: r.id, status: r.status, mint: r.mint, name: c.name, symbol: c.symbol, mode: c.mode, createdAt: r.created_at };
    });
  }

  /** /launches: todos los lanzamientos (estado, progreso de compras y error); los archivados, aparte. */
  listAll(archived = false) {
    const rows = this.db().prepare("SELECT * FROM launch WHERE archived = ? AND (status != 'PREPARED' OR schedule_state IN ('WAITING','PAUSED','FAILED')) ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 500").all(archived ? 1 : 0) as Row[];
    const buys = this.db().prepare("SELECT status, COUNT(*) AS n FROM launch_buy WHERE launch_id = ? GROUP BY status");
    return rows.map((r) => {
      const c = JSON.parse(r.config) as Stored;
      const counts = Object.fromEntries((buys.all(r.id) as { status: string; n: number }[]).map((b) => [b.status, b.n]));
      const sched = r.status === "PREPARED" && r.scheduled_at ? r.schedule_state : null;
      return { id: r.id, status: sched === "WAITING" ? "SCHEDULED" : sched === "PAUSED" ? "PAUSED" : sched === "FAILED" ? "FAILED" : r.status, pausedFrom: r.paused_from, mint: r.mint, name: c.name, symbol: c.symbol, mode: c.mode, devBuyLamports: c.devBuyLamports, holders: c.holders.length, buys: { ok: counts.OK ?? 0, failed: counts.FAILED ?? 0, skipped: counts.SKIPPED ?? 0, pending: counts.PENDING ?? 0 }, createSignature: r.create_sig, error: sched === "FAILED" ? r.schedule_error : r.error, createdAt: r.created_at, updatedAt: r.updated_at, scheduledAt: r.scheduled_at, scheduleState: sched };
    });
  }

  archive(id: string, archived: boolean) {
    const r = this.row(id);
    if (!r) throw Object.assign(new Error("Lanzamiento no encontrado"), { statusCode: 404 });
    if (["CREATING", "CREATED", "BUYING"].includes(r.status)) throw Object.assign(new Error("No se puede archivar un lanzamiento en curso."), { statusCode: 409 });
    this.db().prepare("UPDATE launch SET archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
    return { ok: true };
  }

  async uploadMedia(bytes: Buffer, contentType: string) {
    const img = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType);
    const vid = ["video/mp4", "video/webm"].includes(contentType);
    if (!img && !vid) throw Object.assign(new Error("Formato no admitido. Usa JPG, PNG, GIF, WebP, MP4 o WebM."), { statusCode: 400 });
    if (img && bytes.length > 2 * 1024 * 1024) throw Object.assign(new Error("La imagen supera 2 MB."), { statusCode: 400 });
    if (vid && bytes.length > 10 * 1024 * 1024) throw Object.assign(new Error("El vídeo supera 10 MB."), { statusCode: 400 });
    return this.store.putMedia(bytes, contentType);
  }

  /** Crea la tabla de direcciones de lanzamiento pagada por una wallet propia (paso explícito). */
  async ensureAlt(payerWalletId: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const w = this.wallet(payerWalletId);
    const r = await this.chain.get().launchAlt.ensure(w.address);
    if (r.created) logActivity(this.db(), "launch.alt", `Tabla de direcciones de lanzamiento creada (${r.address}), pagada por ${w.label}`);
    return r;
  }

  // ── Cerrar la tabla de direcciones para recuperar su rent (F2 · restos Should) ─────────────────────────
  // Solo tiene sentido cuando ya no se va a lanzar más: el siguiente lanzamiento la vuelve a crear y paga el rent
  // otra vez. Se bloquea mientras haya un lanzamiento en curso, en pausa o programado.
  private altBlocker() {
    const busy = this.db().prepare("SELECT COUNT(*) AS n FROM launch WHERE status IN ('CREATING','CREATED','BUYING','PAUSED') OR (status = 'PREPARED' AND schedule_state IN ('WAITING','PAUSED'))").get() as { n: number };
    return busy.n ? "Hay un lanzamiento en curso, en pausa o programado: espera a que termine o cancélalo." : null;
  }
  private ownByAddress(address: string | null) {
    return address ? ((this.db().prepare("SELECT id, label, address FROM wallet WHERE address = ? AND archived = 0").get(address) as { id: string; label: string; address: string } | undefined) ?? null) : null;
  }

  async altInfo() {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const st = await this.chain.get().launchAlt.closing();
    const conv = <T extends { authority: string | null; lamports: bigint }>(x: T | null) => (x ? { ...x, lamports: x.lamports.toString(), authorityWallet: this.ownByAddress(x.authority) } : null);
    return { current: conv(st.current), closing: conv(st.closing), blocker: this.altBlocker() };
  }

  async deactivateAlt() {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const b = this.altBlocker();
    if (b) throw Object.assign(new Error(b), { statusCode: 409 });
    const info = await this.altInfo();
    if (info.current && !info.current.authorityWallet) throw Object.assign(new Error("La autoridad de la tabla no es una wallet de la bóveda (o está archivada)."), { statusCode: 409 });
    const res = await this.chain.get().launchAlt.deactivate();
    if (res.status !== "confirmed") throw Object.assign(new Error(res.status === "pending" ? "La desactivación está pendiente de confirmar; vuelve a mirar en unos segundos." : `No se pudo desactivar: ${"message" in res ? res.message : res.status}`), { statusCode: 409 });
    logActivity(this.db(), "launch.alt.deactivate", `Tabla de direcciones ${info.current!.address} desactivada (se podrá cerrar en ~512 slots)`);
    return this.altInfo();
  }

  async closeAlt(recipientId: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const to = this.wallet(recipientId);
    const info = await this.altInfo();
    if (info.closing && !info.closing.authorityWallet) throw Object.assign(new Error("La autoridad de la tabla no es una wallet de la bóveda (o está archivada)."), { statusCode: 409 });
    const res = await this.chain.get().launchAlt.close(to.address);
    if (res.status !== "confirmed") throw Object.assign(new Error(res.status === "pending" ? "El cierre está pendiente de confirmar; vuelve a mirar en unos segundos." : `No se pudo cerrar: ${"message" in res ? res.message : res.status}`), { statusCode: 409 });
    logActivity(this.db(), "launch.alt.close", `Tabla de direcciones ${info.closing!.address} cerrada: ${(Number(info.closing!.lamports) / 1e9).toFixed(6)} SOL de rent a ${to.label}`);
    return { ...(await this.altInfo()), recovered: info.closing!.lamports, to: to.label };
  }

  quote(devBuyLamports: bigint, buys: bigint[]) {
    return this.chain.get().adapter.quoteLaunch({ devBuyLamports, buys });
  }

  /** REQ-LAUNCH-017: dry-run honesto. Simula create + dev buy; las compras de holders se comprueban (aún no hay curva que simular). */
  async preflight(input: unknown) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const cfg = LaunchConfig.parse(input);
    const existing = this.row(cfg.draftId);
    // Ya lanzado o en curso: el dry-run no vuelve a preparar nada
    if (existing && !["PREPARED", "FAILED"].includes(existing.status)) return this.view(cfg.draftId);
    const chain = this.chain.get();
    const dev = this.wallet(cfg.devWalletId);
    const bundle = (cfg.bundle ?? []).map((h) => ({ ...h, w: this.wallet(h.walletId) }));
    const holders = buysAfterCreate(cfg.mode) ? cfg.holders.map((h) => ({ ...h, w: this.wallet(h.walletId) })) : [];
    for (const h of [...bundle, ...holders]) if (h.w.kind !== "wallet") throw Object.assign(new Error(`${h.w.label} no es una wallet operativa.`), { statusCode: 400 });

    // Mint: se genera una sola vez por borrador y se sella antes de enviar nada (REQ-LAUNCH-006). Un mint vanity
    // ligado al borrador (vanity.ts) manda mientras la creación no se haya enviado nunca.
    const vanity = (JSON.parse(kvGet(this.db(), `vanityMint:${cfg.draftId}`) ?? "null") as { address: string } | null)?.address ?? null;
    const neverSent = !this.db().prepare("SELECT 1 FROM tx WHERE idempotency_key = ?").get(`launch:${cfg.draftId}:create`) && (!existing || existing.status === "PREPARED");
    const mint = vanity && neverSent ? vanity : (existing?.mint ?? (await this.vault.createMintKey()));
    // URI pública de la imagen ya subida: local en pruebas, pasarela + CID en mainnet
    const image = this.store.mediaUri(cfg.imageCid);
    const meta = await this.store.putJson({ name: cfg.name, symbol: cfg.symbol, description: cfg.description, image, showName: true, createdOn: "nebula", twitter: cfg.links.x || undefined, telegram: cfg.links.telegram || undefined, website: cfg.links.web || undefined });
    assertUriForProfile(this.profile, meta.uri);

    const checks: Check[] = [];
    // create_v2 + dev buy con una URI normal no cabe en 1.232 bytes sin la tabla de direcciones
    const alt = await chain.launchAlt.status();
    if (!alt.ready) {
      checks.push({ label: "Tabla de direcciones de Nébula (una sola vez)", kind: "setup", ok: false, action: "create-alt", reason: `Falta crearla. Cuesta ~${(Number(alt.rentLamports) / 1e9).toFixed(4)} SOL de rent y la paga la wallet dev; se recupera cerrándola en Ajustes cuando ya no vayas a lanzar más.` });
    }
    const tx = await chain.adapter.buildCreateTx({ name: cfg.name, symbol: cfg.symbol, uri: meta.uri, creator: dev.address, mint, devBuyLamports: BigInt(cfg.devBuyLamports), slippagePct: cfg.slippagePct, mayhem: cfg.mayhem, holderReward: cfg.feeMode === "holders" });
    const transport = bundleTransport(this.chain.jito(), chain.kind === "mock" ? "mock" : "rpc");
    // Con compras en el bundle la propina única va en la última de esas compras, no en la creación.
    const sim = alt.ready ? await chain.sender.send(tx, { idempotencyKey: `launch:${cfg.draftId}:preflight:${Date.now()}`, simulateOnly: true, ...(bundle.length ? { tipLamports: 0n } : {}) }) : { status: "failed" as const, code: "SIMULATION_FAILED" as const, message: "Se simulará cuando exista la tabla de direcciones." };
    const wantTip = this.chain.tipFor("create");
    const tipNote = bundle.length
      ? undefined
      : wantTip === 0n || sim.status !== "simulated"
        ? undefined
        : (sim.tipLamports ?? 0n) > 0n
          ? `Lleva la propina de Jito (${(Number(sim.tipLamports) / 1e9).toLocaleString("es-ES", { maximumFractionDigits: 9 })} SOL) y sale también por el Block Engine.`
          : "La propina de Jito no cabe en esta transacción (1.232 bytes): la creación sale sin propina y solo por el RPC. Las compras sí la llevan.";
    checks.push(
      sim.status === "simulated"
        ? { label: "Crear token + dev buy (una sola transacción)", kind: "simulated", ok: true, units: sim.unitsConsumed, ...(tipNote ? { note: tipNote } : {}) }
        : { label: "Crear token + dev buy (una sola transacción)", kind: "simulated", ok: false, reason: sim.status === "failed" || sim.status === "pending" ? sim.message : "La simulación no devolvió resultado" },
    );
    if (bundle.length) {
      const blocked = transport === "unavailable";
      checks.push({
        label: `Bundle de lanzamiento (${bundle.length} compras + creación)`,
        kind: "checked",
        ok: !blocked,
        ...(blocked
          ? { reason: this.chain.jito().enabled ? "Este perfil no llama al Block Engine. Un envío por el RPC no sería un bundle atómico, así que no se envía nada." : "El bundle necesita Jito activado en Ajustes, con propina de al menos 1.000 lamports. Sin Block Engine no hay envío atómico y no se lanza por el RPC como si lo fuera." }
          : { note: transport === "mock" ? "Se aplica atómico en el simulador local. No se llama a sendBundle y no hay bundle_id." : "sendBundle al Block Engine. El bundle_id solo significa que lo recibió; el aterrizaje se comprueba en la cadena." }),
      });
    }
    const spenders = [
      ...bundle.map((h, i) => ({ ...h, role: "bundle" as const, tip: i === bundle.length - 1 })),
      ...holders.map((h) => ({ ...h, role: "snipe" as const, tip: true })),
    ];
    if (spenders.length) {
      const bal = await chain.reader.balances(spenders.map((h) => h.w.address));
      const fee = txFee(1, 400_000, this.priority());
      const tip = this.chain.tipFor("buy");
      for (const h of spenders) {
        const paysTip = h.tip && tip > 0n && (h.role === "snipe" || bundle.length > 0);
        const need = BigInt(h.lamports) + fee + (paysTip ? tip : 0n) + ATA_BUFFER;
        const have = bal.get(h.w.address) ?? 0n;
        const name = h.role === "bundle" ? "Bundle" : "Snipe";
        checks.push(have >= need ? { label: `${name} · ${h.w.label}`, kind: "checked", ok: true } : { label: `${name} · ${h.w.label}`, kind: "checked", ok: false, reason: `Saldo insuficiente: tiene ${(Number(have) / 1e9).toFixed(4)} SOL y necesita ${(Number(need) / 1e9).toFixed(4)} (compra + fees${paysTip ? " + propina Jito" : ""} + cuenta de token)` });
      }
    }
    const ok = checks.every((c) => c.ok);
    const stored: Stored = { ...cfg, uri: meta.uri, preflight: { ok, checks, at: Date.now() } };
    const now = Date.now();
    this.db()
      .prepare(
        `INSERT INTO launch(id, status, config, preflight_fp, mint, created_at, updated_at) VALUES(?, 'PREPARED', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = 'PREPARED', config = excluded.config, preflight_fp = excluded.preflight_fp, error = NULL, updated_at = excluded.updated_at,
           mint = CASE WHEN launch.status = 'PREPARED' AND launch.create_sig IS NULL THEN excluded.mint ELSE launch.mint END,
           scheduled_at = CASE WHEN launch.preflight_fp IS excluded.preflight_fp THEN launch.scheduled_at ELSE NULL END,
           schedule_state = CASE WHEN launch.preflight_fp IS excluded.preflight_fp THEN launch.schedule_state ELSE NULL END`,
      )
      .run(cfg.draftId, JSON.stringify(stored), ok ? fp(cfg, mint, this.chain.tipFor("create")) : null, mint, now, now);
    return this.view(cfg.draftId);
  }

  /** REQ-LAUNCH-016: pulsar «Lanzar» dos veces nunca produce dos tokens. */
  async execute(id: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const r = this.row(id);
    if (!r) throw Object.assign(new Error("Primero haz el dry-run."), { statusCode: 400 });
    if (r.status !== "PREPARED") return this.view(id);
    const cfg = JSON.parse(r.config) as Stored;
    if (!cfg.preflight?.ok || r.preflight_fp !== fp(LaunchConfig.parse(cfg), r.mint, this.chain.tipFor("create"))) throw Object.assign(new Error("El dry-run no está en verde para esta configuración (o cambió la propina de Jito). Vuelve a simular."), { statusCode: 409 });
    assertUriForProfile(this.profile, cfg.uri);
    const db = this.db();
    const bundle = cfg.bundle ?? [];
    const snipes = buysAfterCreate(cfg.mode) ? cfg.holders : [];
    db.transaction(() => {
      db.prepare("DELETE FROM launch_buy WHERE launch_id = ?").run(id);
      const ins = db.prepare("INSERT INTO launch_buy(launch_id, ord, wallet_id, lamports, status, role) VALUES(?, ?, ?, ?, 'PENDING', ?)");
      bundle.forEach((h, i) => ins.run(id, i, h.walletId, Number(h.lamports), "bundle"));
      snipes.forEach((h, i) => ins.run(id, bundle.length + i, h.walletId, Number(h.lamports), "snipe"));
      // lanzar a mano un programado lo da por disparado (no vuelve a lanzarse a su hora)
      db.prepare("UPDATE launch SET status = 'CREATING', schedule_state = CASE WHEN schedule_state IS NULL THEN NULL ELSE 'FIRED' END, updated_at = ? WHERE id = ?").run(Date.now(), id);
    })();
    logActivity(db, "launch.start", `Lanzamiento de $${cfg.symbol} (${buysAfterCreate(cfg.mode) ? `${MODE_LABEL[cfg.mode]}, ${bundle.length} en el bundle, ${snipes.length} en snipe` : "Manual"}) · mint ${r.mint}`);
    void this.run(id);
    return this.view(id);
  }

  async resume(id: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const r = this.row(id);
    // Programado en pausa: si su hora aún no ha llegado vuelve a esperar; si ya pasó, confirmar = lanzar ahora
    if (r && r.status === "PREPARED" && r.schedule_state === "PAUSED") {
      this.dropPaused(id);
      if ((r.scheduled_at ?? 0) > this.clock()) {
        this.db().prepare("UPDATE launch SET schedule_state = 'WAITING', schedule_error = NULL, updated_at = ? WHERE id = ?").run(this.clock(), id);
        return this.view(id);
      }
      await this.fire(id, true);
      return this.view(id);
    }
    if (!r || r.status !== "PAUSED") return this.view(id);
    this.db().prepare("UPDATE launch SET status = ?, paused_from = NULL, updated_at = ? WHERE id = ?").run(r.paused_from ?? "CREATING", Date.now(), id);
    void this.run(id);
    return this.view(id);
  }

  async waitIdle(id: string, timeoutMs = 120_000) {
    const t = Date.now();
    while ((this.running.has(id) || ["CREATING", "CREATED", "BUYING"].includes(this.row(id)?.status ?? "")) && Date.now() - t < timeoutMs) await new Promise((r) => setTimeout(r, 50));
    return this.view(id);
  }

  private set(id: string, status: Status, extra: Partial<Pick<Row, "create_sig" | "error">> = {}) {
    this.db().prepare("UPDATE launch SET status = ?, create_sig = COALESCE(?, create_sig), error = ?, updated_at = ? WHERE id = ?").run(status, extra.create_sig ?? null, extra.error ?? null, Date.now(), id);
  }

  private pause(id: string, from: Status) {
    const r = this.db().prepare("UPDATE launch SET status = 'PAUSED', paused_from = ?, updated_at = ? WHERE id = ? AND status IN ('CREATING','CREATED','BUYING')").run(from, Date.now(), id);
    if (!r.changes) return;
    const v = this.view(id);
    const list = JSON.parse(kvGet(this.db(), "paused") ?? "[]") as { id: string; kind: string; label: string }[];
    if (!list.some((p) => p.id === id)) kvSet(this.db(), "paused", JSON.stringify([...list, { id, kind: "lanzamiento", label: `Lanzamiento de $${v.symbol}` }]));
  }

  // ── REQ-LAUNCH-015: lanzamiento programado ─────────────────────────
  /** Programa un lanzamiento con el dry-run en verde. Persiste en SQLite: sobrevive a un reinicio. */
  schedule(id: string, at: number) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const r = this.row(id);
    if (!r) throw Object.assign(new Error("Primero haz el dry-run."), { statusCode: 400 });
    if (r.status !== "PREPARED") throw Object.assign(new Error("Este lanzamiento ya no se puede programar."), { statusCode: 409 });
    const cfg = JSON.parse(r.config) as Stored;
    if (!cfg.preflight?.ok || r.preflight_fp !== fp(LaunchConfig.parse(cfg), r.mint, this.chain.tipFor("create"))) throw Object.assign(new Error("El dry-run no está en verde para esta configuración (o cambió la propina de Jito). Vuelve a simular."), { statusCode: 409 });
    const now = this.clock();
    if (at < now + SCHEDULE_MIN_LEAD_MS) throw Object.assign(new Error("Programa con al menos 20 s de margen (se puede cancelar hasta 10 s antes)."), { statusCode: 400 });
    if (at > now + SCHEDULE_MAX_LEAD_MS) throw Object.assign(new Error("Como mucho, 30 días vista."), { statusCode: 400 });
    this.db().prepare("UPDATE launch SET scheduled_at = ?, schedule_state = 'WAITING', schedule_error = NULL, updated_at = ? WHERE id = ?").run(at, now, id);
    logActivity(this.db(), "launch.schedule", `Lanzamiento de $${cfg.symbol} programado para ${new Date(at).toISOString()}`);
    return this.view(id);
  }

  /** Cancelar hasta T−10 s (comprobado aquí, no solo en la interfaz). */
  cancelSchedule(id: string) {
    const r = this.row(id);
    if (!r || r.status !== "PREPARED" || !r.scheduled_at || !["WAITING", "PAUSED", "FAILED"].includes(r.schedule_state ?? "")) throw Object.assign(new Error("No hay un lanzamiento programado que cancelar."), { statusCode: 409 });
    if (r.schedule_state === "WAITING" && this.clock() > r.scheduled_at - SCHEDULE_CANCEL_CUTOFF_MS) throw Object.assign(new Error("Faltan menos de 10 s: ya no se puede cancelar."), { statusCode: 409 });
    this.db().prepare("UPDATE launch SET scheduled_at = NULL, schedule_state = NULL, schedule_error = NULL, updated_at = ? WHERE id = ?").run(this.clock(), id);
    this.dropPaused(id);
    logActivity(this.db(), "launch.unschedule", `Lanzamiento de $${(JSON.parse(r.config) as Stored).symbol} desprogramado`);
    return this.view(id);
  }

  private dropPaused(id: string) {
    const list = JSON.parse(kvGet(this.db(), "paused") ?? "[]") as { id: string }[];
    if (list.some((p) => p.id === id)) kvSet(this.db(), "paused", JSON.stringify(list.filter((p) => p.id !== id)));
  }

  /** Al bloquear (REQ-VAULT-003) los programados pasan a PAUSED y se listan para confirmar al desbloquear. */
  pauseScheduled(reason: "lock" | "due-locked" | "late") {
    const now = this.clock();
    const cond = reason === "due-locked" ? "AND scheduled_at <= ?" : reason === "late" ? "AND scheduled_at <= ?" : "";
    const args = reason === "due-locked" ? [now] : reason === "late" ? [now - SCHEDULE_GRACE_MS] : [];
    const rows = this.db().prepare(`SELECT id, config, scheduled_at FROM launch WHERE status = 'PREPARED' AND schedule_state = 'WAITING' ${cond}`).all(...args) as { id: string; config: string; scheduled_at: number }[];
    if (!rows.length) return 0;
    const list = JSON.parse(kvGet(this.db(), "paused") ?? "[]") as { id: string; kind: string; label: string }[];
    for (const r of rows) {
      const why = reason === "late" ? `Llegó con ${Math.round((now - r.scheduled_at) / 60_000)} min de retraso (app cerrada o suspendida, o RPC caído). No se lanza sin confirmar.` : reason === "due-locked" ? "La bóveda estaba bloqueada a la hora programada." : "La bóveda se bloqueó antes de la hora programada.";
      this.db().prepare("UPDATE launch SET schedule_state = 'PAUSED', schedule_error = ?, updated_at = ? WHERE id = ?").run(why, now, r.id);
      const symbol = (JSON.parse(r.config) as Stored).symbol;
      if (!list.some((p) => p.id === r.id)) list.push({ id: r.id, kind: "lanzamiento", label: `Lanzamiento programado de $${symbol}${reason === "late" ? " (llegó tarde)" : ""}` });
    }
    kvSet(this.db(), "paused", JSON.stringify(list));
    logActivity(this.db(), "launch.schedule.paused", `${rows.length} lanzamientos programados en pausa (${reason === "lock" ? "bloqueo" : reason === "late" ? "llegaron con más de 2 min de retraso" : "llegó la hora con la bóveda bloqueada"})`);
    return rows.length;
  }

  startScheduler(intervalMs = 1000) {
    this.scheduler ??= setInterval(() => void this.tickSchedule().catch((e) => this.log(`Programador: ${(e as Error).message}`)), intervalMs);
    this.scheduler.unref?.();
  }

  stopScheduler() {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = null;
  }

  /** Dispara los programados vencidos: con la bóveda bloqueada no se lanza nada y quedan en pausa. */
  async tickSchedule() {
    // Los que llegan tarde (más de SCHEDULE_GRACE_MS) nunca se lanzan solos, esté la bóveda como esté
    const late = this.pauseScheduled("late");
    const due = this.db().prepare("SELECT id FROM launch WHERE status = 'PREPARED' AND schedule_state = 'WAITING' AND scheduled_at <= ?").all(this.clock()) as { id: string }[];
    if (!due.length) return late;
    if (!this.vault.isUnlocked()) return this.pauseScheduled("due-locked");
    for (const d of due) await this.fire(d.id, false);
    return due.length;
  }

  /** Vuelve a hacer el dry-run con la configuración guardada y solo lanza si sigue en verde. */
  private async fire(id: string, confirmed: boolean) {
    if (this.firing.has(id)) return;
    this.firing.add(id);
    try {
      const r = this.row(id)!;
      const cfg = JSON.parse(r.config) as Stored;
      // REVIEW-F1 P1-1: la fila sigue WAITING mientras se rehace el dry-run; solo pasa a FIRED justo antes
      // de ejecutar. Cualquier fallo deja un estado visible (PAUSED o FAILED), nunca un «disparado» huérfano.
      const { uri: _uri, preflight: _pf, ...plain } = cfg;
      void _uri;
      void _pf;
      let v;
      try {
        v = await this.preflight(plain);
      } catch (e) {
        if (e instanceof VaultError && e.code === "LOCKED") return this.pauseScheduled("due-locked");
        return this.failSchedule(id, cfg.symbol, (e as Error).message, r.scheduled_at);
      }
      if (!v.preflight?.ok) {
        const why = (v.preflight?.checks ?? []).filter((c) => !c.ok).map((c) => `${c.label}: ${c.reason ?? "falló"}`).join(" · ");
        return this.failSchedule(id, cfg.symbol, `El dry-run a la hora programada no está en verde: ${why}`, r.scheduled_at);
      }
      // F2 · bloque 5: misma configuración y mint, pero otra huella = cambió la propina de Jito desde que se programó.
      // No se lanza con costes que no se vieron.
      if (r.preflight_fp && this.row(id)?.preflight_fp !== r.preflight_fp) {
        return this.failSchedule(id, cfg.symbol, "La propina de Jito cambió en Ajustes desde que se programó. Revisa los costes, vuelve a simular y programa de nuevo.", r.scheduled_at);
      }
      this.db().prepare("UPDATE launch SET schedule_state = 'FIRED', updated_at = ? WHERE id = ?").run(this.clock(), id);
      logActivity(this.db(), "launch.schedule.fire", `Lanzamiento programado de $${cfg.symbol}${confirmed ? " (confirmado tras la pausa)" : ""}`);
      try {
        await this.execute(id);
      } catch (e) {
        // execute falla antes de enviar nada (comprobaciones): la programación vuelve a un estado visible
        this.db().prepare("UPDATE launch SET schedule_state = 'WAITING', updated_at = ? WHERE id = ? AND status = 'PREPARED'").run(this.clock(), id);
        if (e instanceof VaultError && e.code === "LOCKED") return this.pauseScheduled("due-locked");
        return this.failSchedule(id, cfg.symbol, `No se pudo lanzar a su hora: ${(e as Error).message}`, r.scheduled_at);
      }
    } finally {
      this.firing.delete(id);
    }
  }

  /**
   * Al arrancar: una fila PREPARED con la programación FIRED quedó interrumpida (cierre entre el disparo y
   * el envío, o datos de una versión anterior). Pasa a FAILED con el motivo para que el operador la vea.
   */
  recoverInterrupted() {
    const rows = this.db().prepare("SELECT id, config, scheduled_at FROM launch WHERE status = 'PREPARED' AND schedule_state = 'FIRED'").all() as { id: string; config: string; scheduled_at: number | null }[];
    for (const r of rows) this.failSchedule(r.id, (JSON.parse(r.config) as Stored).symbol, "La ejecución programada se interrumpió (cierre de la app o error). No se envió nada: revisa y vuelve a programar o lanza a mano.", r.scheduled_at);
    return rows.length;
  }

  private failSchedule(id: string, symbol: string, msg: string, at: number | null) {
    this.db().prepare("UPDATE launch SET schedule_state = 'FAILED', schedule_error = ?, scheduled_at = COALESCE(scheduled_at, ?), updated_at = ? WHERE id = ?").run(msg, at, this.clock(), id);
    logActivity(this.db(), "launch.schedule.failed", `Lanzamiento programado de $${symbol} no ejecutado: ${msg}`);
  }

  pauseAllRunning() {
    const rows = this.db().prepare("SELECT id, status FROM launch WHERE status IN ('CREATING','CREATED','BUYING')").all() as { id: string; status: Status }[];
    for (const r of rows) this.pause(r.id, r.status);
    return rows.length;
  }

  /** Bundle atómico (creación + compras marcadas). El snipe no corre si esto no aterriza entero. */
  private async submitBundle(id: string, cfg: Stored, devAddress: string): Promise<boolean> {
    const chain = this.chain.get();
    const transport = bundleTransport(this.chain.jito(), chain.kind === "mock" ? "mock" : "rpc");
    const remember = (status: string, bundleId: string | null, message?: string) => kvSet(this.db(), `launch-bundle:${id}`, JSON.stringify({ transport: transport === "mock" ? "simulated" : "block-engine", bundleId, status, message }));
    if (transport === "unavailable") {
      const message = "No se puede enviar el bundle con la configuración actual de Jito. No se ha lanzado nada.";
      remember("failed", null, message);
      this.set(id, "FAILED", { error: message });
      this.skipSnipes(id, "El bundle no se envió: el snipe no se dispara.");
      logActivity(this.db(), "launch.failed", `Lanzamiento de $${cfg.symbol} fallido: ${message}`);
      return true;
    }
    const r = this.row(id)!;
    const tx = await chain.adapter.buildCreateTx({ name: cfg.name, symbol: cfg.symbol, uri: cfg.uri, creator: devAddress, mint: r.mint, devBuyLamports: BigInt(cfg.devBuyLamports), slippagePct: cfg.slippagePct, mayhem: cfg.mayhem, holderReward: cfg.feeMode === "holders" });
    const built = await chain.adapter.buildLaunchBundleBuys({ mint: r.mint, creator: devAddress, devBuyLamports: BigInt(cfg.devBuyLamports), slippagePct: cfg.slippagePct, mayhem: cfg.mayhem, holderReward: cfg.feeMode === "holders", buys: cfg.bundle.map((b) => ({ user: this.wallet(b.walletId).address, lamports: BigInt(b.lamports) })) });
    const res = await chain.sender.sendBundle(
      [{ tx, idempotencyKey: `launch:${id}:create` }, ...cfg.bundle.map((b, i) => ({ tx: built[i], idempotencyKey: `launch:${id}:buy:${b.walletId}` }))],
      { bundleKey: `launch:${id}:bundle` },
    );
    if (res.status === "confirmed") {
      remember("confirmed", res.bundleId);
      this.set(id, "CREATED", { create_sig: res.signatures[0] });
      await this.markBundleBuys(id, r.mint, res.signatures, res.signatures.map(() => true));
      logActivity(this.db(), "launch.bundle", res.simulated ? `Bundle de $${cfg.symbol} simulado en local: atómico, sin Block Engine y sin bundle_id.` : `Bundle de $${cfg.symbol} aterrizado (${res.bundleId}).`);
      return false;
    }
    if (res.status === "pending") {
      remember("pending", res.bundleId, res.message);
      this.pause(id, "CREATING");
      logActivity(this.db(), "launch.bundle", `Bundle de $${cfg.symbol} pendiente: ${res.message}`);
      return true;
    }
    if (res.status === "partial") {
      remember("partial", res.bundleId, res.message);
      this.set(id, "FAILED", { create_sig: res.ok[0] ? res.signatures[0] : undefined, error: res.message });
      await this.markBundleBuys(id, r.mint, res.signatures, res.ok);
      this.skipSnipes(id, "El bundle no aterrizó completo: el snipe no se dispara.");
      logActivity(this.db(), "launch.failed", `Bundle de $${cfg.symbol} a medias: ${res.message}`);
      return true;
    }
    remember("failed", null, res.message);
    this.set(id, "FAILED", { error: res.message });
    this.db().prepare("UPDATE launch_buy SET status = 'FAILED', reason = ? WHERE launch_id = ? AND role = 'bundle' AND status = 'PENDING'").run(res.message, id);
    this.skipSnipes(id, "El bundle no se envió: el snipe no se dispara.");
    logActivity(this.db(), "launch.failed", `Bundle de $${cfg.symbol} rechazado: ${res.message}`);
    return true;
  }

  private async markBundleBuys(id: string, mint: string, signatures: string[], ok: boolean[]) {
    const rows = this.db().prepare("SELECT ord, wallet_id FROM launch_buy WHERE launch_id = ? AND role = 'bundle' ORDER BY ord").all(id) as { ord: number; wallet_id: string }[];
    const upd = this.db().prepare("UPDATE launch_buy SET status = ?, tokens = ?, signature = ?, reason = ? WHERE launch_id = ? AND ord = ?");
    for (let i = 0; i < rows.length; i++) {
      const sig = signatures[i + 1] ?? null;
      const good = ok[i + 1] === true;
      const tokens = good ? (await this.chain.get().reader.tokenBalance(mint, this.wallet(rows[i].wallet_id).address).catch(() => 0n)).toString() : null;
      upd.run(good ? "OK" : "FAILED", tokens, sig, good ? null : "Esta compra del bundle no se confirmó.", id, rows[i].ord);
    }
  }

  private skipSnipes(id: string, why: string) {
    this.db().prepare("UPDATE launch_buy SET status = 'SKIPPED', reason = ? WHERE launch_id = ? AND role = 'snipe' AND status = 'PENDING'").run(why, id);
  }

  private async run(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const chain = this.chain.get();
      let r = this.row(id)!;
      const cfg = JSON.parse(r.config) as Stored;
      const dev = this.wallet(cfg.devWalletId);

      if (r.status === "CREATING") {
        const bundle = cfg.bundle ?? [];
        if (bundle.length) {
          const stopped = await this.submitBundle(id, cfg, dev.address);
          if (stopped) return;
        } else if (await chain.reader.accountExists(r.mint)) this.set(id, "CREATED");
        else {
          await chain.launchAlt.status(); // carga la tabla de direcciones (p. ej. tras un reinicio)
          const tx = await chain.adapter.buildCreateTx({ name: cfg.name, symbol: cfg.symbol, uri: cfg.uri, creator: dev.address, mint: r.mint, devBuyLamports: BigInt(cfg.devBuyLamports), slippagePct: cfg.slippagePct, mayhem: cfg.mayhem, holderReward: cfg.feeMode === "holders" });
          const res = await chain.sender.send(tx, { idempotencyKey: `launch:${id}:create` });
          if (res.status === "confirmed") this.set(id, "CREATED", { create_sig: res.signature });
          else if (res.status === "pending") return this.pause(id, "CREATING");
          else if (res.status === "failed") {
            this.set(id, "FAILED", { error: res.message });
            logActivity(this.db(), "launch.failed", `Lanzamiento de $${cfg.symbol} fallido: ${res.message}`);
            return;
          }
        }
        r = this.row(id)!;
      }
      if (r.status === "CREATED") {
        this.set(id, buysAfterCreate(cfg.mode) ? "BUYING" : "DONE");
        r = this.row(id)!;
      }
      if (r.status === "BUYING") {
        const buys = this.db().prepare("SELECT ord, wallet_id, lamports FROM launch_buy WHERE launch_id = ? AND status = 'PENDING' AND role = 'snipe' ORDER BY ord").all(id) as { ord: number; wallet_id: string; lamports: number }[];
        const upd = this.db().prepare("UPDATE launch_buy SET status = ?, tokens = ?, signature = ?, reason = ? WHERE launch_id = ? AND ord = ?");
        const guard = cfg.guard ?? null;
        // la ventana del guard empieza al pasar a las compras (justo tras la creación confirmada)
        const guardStart = this.clock();
        // Pro: cada compra SALE a su hora (espera contada desde que salió la anterior; la primera, desde la
        // creación confirmada) y las confirmaciones corren a la vez. Quick: una tras otra, esperando cada una.
        const pro = cfg.mode === "pro";
        const inflight: Promise<void>[] = [];
        let unknownLanding = false;
        let lastStart = Date.now();
        for (const b of buys) {
          if (this.row(id)!.status !== "BUYING") break;
          await this.testHooks.beforeBuy?.(id, b.ord);
          // Espera fija (sin aleatoriedad). Se corta si el lanzamiento deja de estar en BUYING (pausa, bloqueo);
          // al reanudar, la espera de la wallet en curso cuenta de nuevo desde ese momento.
          const delayMs = pro ? (cfg.holders.find((h) => h.walletId === b.wallet_id)?.delayMs ?? 0) : 0;
          if (delayMs > 0) {
            const until = lastStart + delayMs;
            while (Date.now() < until) {
              if (this.row(id)!.status !== "BUYING") break;
              await new Promise((res) => setTimeout(res, Math.min(50, Math.max(1, until - Date.now()))));
            }
            if (this.row(id)!.status !== "BUYING") break;
          }
          lastStart = Date.now();
          // REQ-LAUNCH-014: dentro de la ventana, si las compras externas superan el umbral se completa antes
          if (guard && this.clock() - guardStart <= guard.windowSec * 1000) {
            // Falla cerrado: sin datos de la cadena (429, timeout) no se compra a ciegas (REVIEW-F1 P1-3)
            let ext: bigint | null = null;
            let readError = "";
            for (let attempt = 0; attempt < 2 && ext === null; attempt++) {
              try {
                ext = await this.externalBuys(r.mint, guard.whitelist);
              } catch (e) {
                readError = (e as Error).message;
                if (attempt === 0) await new Promise((res) => setTimeout(res, 1500));
              }
            }
            if (ext === null) {
              const why = `Launch Guard sin datos de la cadena (${readError.slice(0, 120)}): no se compra a ciegas`;
              const n = this.db().prepare("UPDATE launch_buy SET status = 'SKIPPED', reason = ? WHERE launch_id = ? AND status = 'PENDING'").run(why, id).changes;
              logActivity(this.db(), "launch.guard", `${why}: ${n} compras planificadas omitidas en $${cfg.symbol} (no se vende nada)`);
              break;
            }
            if (ext > BigInt(guard.thresholdLamports)) {
              const why = `Launch Guard: compras externas de ${(Number(ext) / 1e9).toFixed(4)} SOL superan el umbral de ${(Number(guard.thresholdLamports) / 1e9).toFixed(4)} SOL`;
              const n = this.db().prepare("UPDATE launch_buy SET status = 'SKIPPED', reason = ? WHERE launch_id = ? AND status = 'PENDING'").run(why, id).changes;
              logActivity(this.db(), "launch.guard", `${why}: ${n} compras planificadas omitidas en $${cfg.symbol} (no se vende nada)`);
              break;
            }
          }
          const w = this.wallet(b.wallet_id);
          let tx;
          try {
            tx = await chain.adapter.buildBuyTx({ mint: r.mint, user: w.address, lamports: BigInt(b.lamports), slippagePct: cfg.slippagePct });
          } catch (e) {
            upd.run("FAILED", null, null, (e as Error).message, id, b.ord);
            continue;
          }
          const mint = r.mint;
          const settle = async () => {
            const res = await chain.sender.send(tx, { idempotencyKey: `launch:${id}:buy:${b.wallet_id}` });
            if (res.status === "confirmed") upd.run("OK", (await chain.reader.tokenBalance(mint, w.address).catch(() => 0n)).toString(), res.signature, null, id, b.ord);
            else if (res.status === "pending") unknownLanding = true;
            else if (res.status === "failed") upd.run("FAILED", null, res.signature ?? null, res.message, id, b.ord);
          };
          if (!pro) {
            await settle();
            if (unknownLanding) return this.pause(id, "BUYING");
            continue;
          }
          // En Pro la confirmación no frena la siguiente compra; un error inesperado no dice si se emitió: pausa
          inflight.push(
            settle().catch((e) => {
              unknownLanding = true;
              this.log(`Compra ${b.ord} de ${id}: ${(e as Error).message}`);
            }),
          );
        }
        await Promise.all(inflight);
        if (unknownLanding) return this.pause(id, "BUYING");
        if (this.row(id)!.status !== "BUYING") return;
        this.set(id, "DONE");
      }
      const v = this.view(id);
      if (v.status === "DONE") logActivity(this.db(), "launch.done", `Lanzado $${cfg.symbol} · mint ${r.mint}${v.buys.length ? ` · ${v.buys.filter((b) => b.status === "OK").length}/${v.buys.length} compras` : ""}`);
    } catch (e) {
      const cur = this.row(id);
      if (e instanceof VaultError && e.code === "LOCKED" && cur) this.pause(id, cur.status === "PAUSED" ? "CREATING" : cur.status);
      else if (cur && ["CREATING", "CREATED", "BUYING"].includes(cur.status)) {
        this.log(`Lanzamiento ${id} interrumpido: ${(e as Error).message}`);
        this.pause(id, cur.status);
      }
    } finally {
      this.running.delete(id);
    }
  }
}
