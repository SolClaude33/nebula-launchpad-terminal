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
  mode: z.enum(["quick", "manual"]),
  holders: z.array(z.object({ walletId: z.string(), lamports: z.string().regex(/^\d+$/) })).max(40).default([]),
  slippagePct: z.number().min(0.1).max(50),
  mayhem: z.boolean().default(false),
  feeMode: z.enum(["creator", "holders"]),
  feeAck: z.literal(true, { message: "Confirma el destino de las comisiones (irreversible)" }),
});
export type LaunchConfig = z.infer<typeof LaunchConfig>;

type Status = "PREPARED" | "CREATING" | "CREATED" | "BUYING" | "DONE" | "FAILED" | "PAUSED";
type Row = { id: string; status: Status; paused_from: Status | null; config: string; preflight_fp: string | null; mint: string; create_sig: string | null; error: string | null; created_at: number; updated_at: number };
type Check = { label: string; kind: "simulated" | "checked" | "setup"; ok: boolean; reason?: string; units?: number; action?: "create-alt" };
type Stored = LaunchConfig & { uri: string; preflight?: { ok: boolean; checks: Check[]; at: number } };

const ATA_BUFFER = 3_000_000n; // cuenta de token (Token-2022) + margen
const fp = (c: LaunchConfig, mint: string) => createHash("sha256").update(JSON.stringify({ ...c, draftId: undefined }) + mint).digest("hex");

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
  ) {}

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
    const buys = this.db().prepare("SELECT b.ord, b.wallet_id AS walletId, w.label, b.lamports, b.status, b.tokens, b.signature, b.reason FROM launch_buy b LEFT JOIN wallet w ON w.id = b.wallet_id WHERE b.launch_id = ? ORDER BY b.ord").all(id);
    return { id: r.id, status: r.status, pausedFrom: r.paused_from, mint: r.mint, createSignature: r.create_sig, error: r.error, name: cfg.name, symbol: cfg.symbol, uri: cfg.uri, mode: cfg.mode, preflight: cfg.preflight ?? null, buys, updatedAt: r.updated_at };
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
    const rows = this.db().prepare("SELECT id, status, paused_from, mint, config, create_sig, error, created_at, updated_at FROM launch WHERE archived = ? AND status != 'PREPARED' ORDER BY created_at DESC LIMIT 500").all(archived ? 1 : 0) as Row[];
    const buys = this.db().prepare("SELECT status, COUNT(*) AS n FROM launch_buy WHERE launch_id = ? GROUP BY status");
    return rows.map((r) => {
      const c = JSON.parse(r.config) as Stored;
      const counts = Object.fromEntries((buys.all(r.id) as { status: string; n: number }[]).map((b) => [b.status, b.n]));
      return { id: r.id, status: r.status, pausedFrom: r.paused_from, mint: r.mint, name: c.name, symbol: c.symbol, mode: c.mode, devBuyLamports: c.devBuyLamports, holders: c.holders.length, buys: { ok: counts.OK ?? 0, failed: counts.FAILED ?? 0, skipped: counts.SKIPPED ?? 0, pending: counts.PENDING ?? 0 }, createSignature: r.create_sig, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at };
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
    const holders = cfg.mode === "quick" ? cfg.holders.map((h) => ({ ...h, w: this.wallet(h.walletId) })) : [];
    if (cfg.mode === "quick" && holders.length === 0) throw Object.assign(new Error("El modo Quick necesita al menos una wallet holder."), { statusCode: 400 });
    if (new Set(holders.map((h) => h.walletId)).size !== holders.length) throw Object.assign(new Error("Hay wallets repetidas en el plan."), { statusCode: 400 });
    if (holders.some((h) => h.walletId === dev.id)) throw Object.assign(new Error("La wallet dev no puede estar también como holder."), { statusCode: 400 });

    // Mint: se genera una sola vez por borrador y se sella antes de enviar nada (REQ-LAUNCH-006)
    const mint = existing?.mint ?? (await this.vault.createMintKey());
    // URI pública de la imagen ya subida: local en pruebas, pasarela + CID en mainnet
    const image = this.store.mediaUri(cfg.imageCid);
    const meta = await this.store.putJson({ name: cfg.name, symbol: cfg.symbol, description: cfg.description, image, showName: true, createdOn: "nebula", twitter: cfg.links.x || undefined, telegram: cfg.links.telegram || undefined, website: cfg.links.web || undefined });
    assertUriForProfile(this.profile, meta.uri);

    const checks: Check[] = [];
    // create_v2 + dev buy con una URI normal no cabe en 1.232 bytes sin la tabla de direcciones
    const alt = await chain.launchAlt.status();
    if (!alt.ready) {
      checks.push({ label: "Tabla de direcciones de Nébula (una sola vez)", kind: "setup", ok: false, action: "create-alt", reason: `Falta crearla. Cuesta ~${(Number(alt.rentLamports) / 1e9).toFixed(4)} SOL de rent y la paga la wallet dev; solo se recuperaría cerrando la tabla (aún no implementado).` });
    }
    const tx = await chain.adapter.buildCreateTx({ name: cfg.name, symbol: cfg.symbol, uri: meta.uri, creator: dev.address, mint, devBuyLamports: BigInt(cfg.devBuyLamports), slippagePct: cfg.slippagePct, mayhem: cfg.mayhem, holderReward: cfg.feeMode === "holders" });
    const sim = alt.ready ? await chain.sender.send(tx, { idempotencyKey: `launch:${cfg.draftId}:preflight:${Date.now()}`, simulateOnly: true }) : { status: "failed" as const, code: "SIMULATION_FAILED" as const, message: "Se simulará cuando exista la tabla de direcciones." };
    checks.push(
      sim.status === "simulated"
        ? { label: "Crear token + dev buy (una sola transacción)", kind: "simulated", ok: true, units: sim.unitsConsumed }
        : { label: "Crear token + dev buy (una sola transacción)", kind: "simulated", ok: false, reason: sim.status === "failed" || sim.status === "pending" ? sim.message : "La simulación no devolvió resultado" },
    );
    if (holders.length) {
      const bal = await chain.reader.balances(holders.map((h) => h.w.address));
      const fee = txFee(1, 400_000, this.priority());
      for (const h of holders) {
        const need = BigInt(h.lamports) + fee + ATA_BUFFER;
        const have = bal.get(h.w.address) ?? 0n;
        checks.push(have >= need ? { label: `Compra · ${h.w.label}`, kind: "checked", ok: true } : { label: `Compra · ${h.w.label}`, kind: "checked", ok: false, reason: `Saldo insuficiente: tiene ${(Number(have) / 1e9).toFixed(4)} SOL y necesita ${(Number(need) / 1e9).toFixed(4)} (compra + fees + cuenta de token)` });
      }
    }
    const ok = checks.every((c) => c.ok);
    const stored: Stored = { ...cfg, uri: meta.uri, preflight: { ok, checks, at: Date.now() } };
    const now = Date.now();
    this.db()
      .prepare(
        `INSERT INTO launch(id, status, config, preflight_fp, mint, created_at, updated_at) VALUES(?, 'PREPARED', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = 'PREPARED', config = excluded.config, preflight_fp = excluded.preflight_fp, error = NULL, updated_at = excluded.updated_at`,
      )
      .run(cfg.draftId, JSON.stringify(stored), ok ? fp(cfg, mint) : null, mint, now, now);
    return this.view(cfg.draftId);
  }

  /** REQ-LAUNCH-016: pulsar «Lanzar» dos veces nunca produce dos tokens. */
  async execute(id: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const r = this.row(id);
    if (!r) throw Object.assign(new Error("Primero haz el dry-run."), { statusCode: 400 });
    if (r.status !== "PREPARED") return this.view(id);
    const cfg = JSON.parse(r.config) as Stored;
    if (!cfg.preflight?.ok || r.preflight_fp !== fp(LaunchConfig.parse(cfg), r.mint)) throw Object.assign(new Error("El dry-run no está en verde para esta configuración. Vuelve a simular."), { statusCode: 409 });
    assertUriForProfile(this.profile, cfg.uri);
    const db = this.db();
    db.transaction(() => {
      db.prepare("DELETE FROM launch_buy WHERE launch_id = ?").run(id);
      if (cfg.mode === "quick") {
        const ins = db.prepare("INSERT INTO launch_buy(launch_id, ord, wallet_id, lamports, status) VALUES(?, ?, ?, ?, 'PENDING')");
        cfg.holders.forEach((h, i) => ins.run(id, i, h.walletId, Number(h.lamports)));
      }
      db.prepare("UPDATE launch SET status = 'CREATING', updated_at = ? WHERE id = ?").run(Date.now(), id);
    })();
    logActivity(db, "launch.start", `Lanzamiento de $${cfg.symbol} (${cfg.mode === "quick" ? `Quick, ${cfg.holders.length} holders` : "Manual"}) · mint ${r.mint}`);
    void this.run(id);
    return this.view(id);
  }

  async resume(id: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const r = this.row(id);
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

  pauseAllRunning() {
    const rows = this.db().prepare("SELECT id, status FROM launch WHERE status IN ('CREATING','CREATED','BUYING')").all() as { id: string; status: Status }[];
    for (const r of rows) this.pause(r.id, r.status);
    return rows.length;
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
        // Tras un reinicio: si el mint ya existe en cadena, la creación ya aterrizó
        if (await chain.reader.accountExists(r.mint)) this.set(id, "CREATED");
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
        this.set(id, cfg.mode === "quick" ? "BUYING" : "DONE");
        r = this.row(id)!;
      }
      if (r.status === "BUYING") {
        const buys = this.db().prepare("SELECT ord, wallet_id, lamports FROM launch_buy WHERE launch_id = ? AND status = 'PENDING' ORDER BY ord").all(id) as { ord: number; wallet_id: string; lamports: number }[];
        const upd = this.db().prepare("UPDATE launch_buy SET status = ?, tokens = ?, signature = ?, reason = ? WHERE launch_id = ? AND ord = ?");
        for (const b of buys) {
          if (this.row(id)!.status !== "BUYING") return;
          const w = this.wallet(b.wallet_id);
          let tx;
          try {
            tx = await chain.adapter.buildBuyTx({ mint: r.mint, user: w.address, lamports: BigInt(b.lamports), slippagePct: cfg.slippagePct });
          } catch (e) {
            upd.run("FAILED", null, null, (e as Error).message, id, b.ord);
            continue;
          }
          const res = await chain.sender.send(tx, { idempotencyKey: `launch:${id}:buy:${b.wallet_id}` });
          if (res.status === "confirmed") upd.run("OK", (await chain.reader.tokenBalance(r.mint, w.address)).toString(), res.signature, null, id, b.ord);
          else if (res.status === "pending") return this.pause(id, "BUYING");
          else if (res.status === "failed") upd.run("FAILED", null, res.signature ?? null, res.message, id, b.ord);
        }
        this.set(id, "DONE");
      }
      const v = this.view(id);
      if (v.status === "DONE") logActivity(this.db(), "launch.done", `Lanzado $${cfg.symbol} · mint ${r.mint}${cfg.mode === "quick" ? ` · ${(v.buys as { status: string }[]).filter((b) => b.status === "OK").length}/${cfg.holders.length} compras` : ""}`);
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
