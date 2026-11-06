// REQ-AUTO-001…010: automatizaciones de la posición propia, ejecutadas en el servidor sobre `trading.ts`.
//
// - Cada ejecución es una orden hija de `Trading` con id `auto-<tarea>-<generación>-<n>`, así que cada wallet
//   lleva su propia idempotency key `trade:auto-<tarea>-<generación>-<n>:<wallet>`. La orden se apunta en el
//   estado de la tarea ANTES de crearla: tras un cierre se reanuda la misma (mismas keys), nunca otra.
// - El estado vive en SQLite (`task.state`); el temporizador solo despierta al motor, que relee la tarea
//   antes de cada paso (el bloqueo y el reinicio la cambian por debajo con `pauseRunningTasks`).
// - Pausar o parar nunca vende: detiene la orden en curso (lo ya emitido termina) y no crea otra.
// - Sin backlog: al reanudar se hace como mucho una ejecución y se reprograma desde ese momento.
// - Un envío `pending` pausa la tarea (nunca FAILED ni cuenta como error).
// - «N errores seguidos»: cuenta cada ejecución en la que no entró ninguna wallet (fallidas u omitidas).
//   Esperar (retardo, fuera de rango, sin precio, migración en curso) no cuenta.
// - Fin: DCA → COMPLETED al llegar al monto o a la duración (la que llegue antes en «lo primero»).
//   Límite → COMPLETED con todos los objetivos y TIMEOUT si caduca antes. La duración es de reloj: el
//   tiempo en pausa cuenta.
import { randomUUID } from "node:crypto";
import { AUTO_FINAL, CreateAutomationBody, dcaPlan, type AutoStatus, type AutomationConfig, type AutomationExecution } from "@nebula/shared";
import type { z } from "zod";
import type { DB } from "./db";
import { logActivity } from "./db";
import type { Vault } from "./signer";
import { VaultError } from "./signer";
import type { Live } from "./live";
import type { InternalOrder, Trading } from "./trading";
import { clearPaused, pausedList } from "./tasks";
import { kvSet } from "./db";

const TICK_MS = 300;
/** espera tras una ejecución de límite en la que no entró nadie (no se reintenta en bucle) */
export const LIMIT_RETRY_MS = 10_000;
/** espera tras un error inesperado (RPC) antes de volver a mirar */
const ERROR_BACKOFF_MS = 5_000;

type OrderRef = { id: string; seq: number; target: number | null; body: InternalOrder };
export type AutoState = {
  startAt: number | null;
  endsAt: number | null;
  nextAt: number | null;
  /** ejecuciones hechas en esta generación */
  seq: number;
  /** suma de lo ejecutado (OK): lamports en compras, unidades del token en ventas */
  spent: string;
  consecErrors: number;
  /** objetivos de límite ya ejecutados (siempre en orden: 0…fired-1) */
  fired: number;
  order: OrderRef | null;
  /** por qué no se ejecuta ahora mismo (retardo, rango, sin precio…) */
  waiting: string | null;
  lastError: string | null;
  endReason: string | null;
  mcUsd: number | null;
};
type Row = { id: string; type: "dca" | "limit"; label: string; status: AutoStatus; config: string; attempt: number; mint: string; state: string; created_at: number; updated_at: number };
type Task = Omit<Row, "config" | "state"> & { config: AutomationConfig; state: AutoState };

const fresh = (): AutoState => ({ startAt: null, endsAt: null, nextAt: null, seq: 0, spent: "0", consecErrors: 0, fired: 0, order: null, waiting: null, lastError: null, endReason: null, mcUsd: null });
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const fmtUsd = (v: number) => `$${v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} K` : v.toFixed(0)}`;

export class Automations {
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: () => DB,
    private vault: Vault,
    private trading: Trading,
    private live: Live,
    private clock: () => number,
    private log: (m: string) => void,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── lectura ─────────────────────────────────────────────
  private load(id: string): Task {
    const r = this.db().prepare("SELECT * FROM task WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw bad("Automatización no encontrada", 404);
    return { ...r, config: JSON.parse(r.config), state: { ...fresh(), ...JSON.parse(r.state || "{}") } };
  }

  private save(id: string, state: AutoState) {
    this.db().prepare("UPDATE task SET state = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(state), Date.now(), id);
  }

  /** Cambia de estado solo si sigue en `from` (el bloqueo o el operador pueden haberlo cambiado ya). */
  private transition(id: string, from: AutoStatus[], to: AutoStatus) {
    const q = `UPDATE task SET status = ?, updated_at = ? WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`;
    return this.db().prepare(q).run(to, Date.now(), id, ...from).changes > 0;
  }

  private devIds(mint: string) {
    const ids = new Set((this.db().prepare("SELECT id FROM wallet WHERE role = 'dev'").all() as { id: string }[]).map((r) => r.id));
    const l = this.db().prepare("SELECT config FROM launch WHERE mint = ?").all(mint) as { config: string }[];
    for (const x of l) {
      const d = (JSON.parse(x.config) as { devWalletId?: string }).devWalletId;
      if (d) ids.add(d);
    }
    return ids;
  }

  private symbol(mint: string) {
    const l = this.db().prepare("SELECT config FROM launch WHERE mint = ? LIMIT 1").get(mint) as { config: string } | undefined;
    return l ? (JSON.parse(l.config) as { symbol?: string }).symbol ?? null : null;
  }

  view(id: string) {
    const t = this.load(id);
    return this.summary(t);
  }

  private summary(t: Task) {
    const c = t.config;
    const dev = this.devIds(t.mint);
    const wallets = this.db().prepare(`SELECT id, label, role FROM wallet WHERE id IN (${c.walletIds.map(() => "?").join(",")})`).all(...c.walletIds) as { id: string; label: string; role: string | null }[];
    const plan = c.type === "dca" ? dcaPlan(c, c.walletIds.length) : null;
    // ejecuciones previstas = las hechas + las que faltan con la configuración actual (tras editar en pausa)
    let planned = plan?.executions ?? null;
    if (c.type === "dca" && t.status !== "IDLE" && t.state.startAt !== null) {
      const left: number[] = [];
      if (c.end.kind !== "duration") {
        const rem = BigInt(c.end.totalAmount!) - BigInt(t.state.spent);
        left.push(rem <= 0n ? 0 : (dcaPlan({ ...c, end: { kind: "amount", totalAmount: rem.toString(), durationSec: null } }, c.walletIds.length).executions ?? 0));
      }
      if (c.end.kind !== "amount" && t.state.endsAt !== null) {
        const from = Math.max(t.state.nextAt ?? t.state.startAt, t.state.startAt);
        left.push(Math.max(0, Math.ceil((t.state.endsAt - from) / (c.intervalSec * 1000))));
      }
      if (left.length) planned = t.state.seq + Math.min(...left);
    }
    return {
      id: t.id,
      type: t.type,
      side: c.side,
      label: t.label,
      mint: t.mint,
      symbol: this.symbol(t.mint),
      status: t.status,
      generation: t.attempt,
      config: c,
      wallets: wallets.map((w) => ({ id: w.id, label: w.label, dev: dev.has(w.id) })),
      // REQ-AUTO-010: la tarjeta muestra «incl. dev» cuando la incluye
      includesDev: c.walletIds.some((w) => dev.has(w)),
      progress:
        c.type === "dca"
          ? { executions: t.state.seq, planned, spent: t.state.spent, total: c.end.kind !== "duration" ? c.end.totalAmount : null, nextAmount: plan!.amountAt(t.state.seq).toString() }
          : { fired: t.state.fired, targets: c.targets.length, next: c.targets[t.state.fired]?.mcUsd ?? null },
      state: { startAt: t.state.startAt, endsAt: t.state.endsAt, nextAt: t.state.nextAt, waiting: t.state.waiting, lastError: t.state.lastError, endReason: t.state.endReason, consecErrors: t.state.consecErrors, mcUsd: t.state.mcUsd, inFlight: t.state.order?.id ?? null },
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  }

  list(mint?: string) {
    const rows = (mint ? this.db().prepare("SELECT id FROM task WHERE mint = ? ORDER BY created_at DESC").all(mint) : this.db().prepare("SELECT id FROM task ORDER BY created_at DESC").all()) as { id: string }[];
    return { items: rows.map((r) => this.view(r.id)) };
  }

  /** REQ-AUTO-007: ejecuciones con su resultado por wallet, de la más nueva a la más antigua, paginadas. */
  executions(id: string, opts: { before?: number; limit?: number } = {}) {
    this.load(id);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const rows = this.db()
      .prepare(`SELECT rowid AS rid, generation, seq, order_id, target, mc_usd, at FROM task_run WHERE task_id = ? ${opts.before ? "AND rowid < ?" : ""} ORDER BY rowid DESC LIMIT ?`)
      .all(...(opts.before ? [id, opts.before, limit + 1] : [id, limit + 1])) as { rid: number; generation: number; seq: number; order_id: string; target: number | null; mc_usd: number | null; at: number }[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const items: (AutomationExecution & { cursor: number })[] = page.map((r) => {
      let order: ReturnType<Trading["view"]> | null = null;
      try {
        order = this.trading.view(r.order_id);
      } catch {}
      return {
        cursor: r.rid,
        seq: r.seq,
        generation: r.generation,
        orderId: r.order_id,
        at: r.at,
        mcUsd: r.mc_usd,
        target: r.target,
        orderStatus: order?.status ?? "PREPARING",
        items: (order?.items ?? []).map((i) => ({ walletId: i.walletId, label: i.label, side: order!.side as "buy" | "sell", status: i.status, amount: i.amount, result: i.result, signature: i.signature, reason: i.reason, retries: i.retries })),
      };
    });
    return { items, before: more ? page[page.length - 1].rid : null };
  }

  // ── validación ──────────────────────────────────────────
  private validate(c: AutomationConfig) {
    const wallets = this.db().prepare(`SELECT id, label, role FROM wallet WHERE archived = 0 AND kind = 'wallet' AND id IN (${c.walletIds.map(() => "?").join(",")})`).all(...c.walletIds) as { id: string; label: string }[];
    if (wallets.length !== new Set(c.walletIds).size) throw bad("Una de las wallets no existe o está archivada.");
    const dev = this.devIds(c.mint);
    const devs = wallets.filter((w) => dev.has(w.id));
    if (devs.length && !c.includeDev) throw bad(`La wallet dev (${devs.map((d) => d.label).join(", ")}) queda excluida por defecto. Actívala de forma explícita con «Incluir la wallet dev».`);
  }

  private labelFor(c: AutomationConfig) {
    const sym = this.symbol(c.mint);
    const side = c.side === "buy" ? "compra" : "venta";
    return c.type === "dca" ? `DCA de ${side}${sym ? ` · ${sym}` : ""}` : `Límite de ${side} · ${c.targets.length} ${c.targets.length === 1 ? "objetivo" : "objetivos"}${sym ? ` · ${sym}` : ""}`;
  }

  // ── ciclo de vida (REQ-AUTO-006) ─────────────────────────
  create(body: z.infer<typeof CreateAutomationBody>) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const exists = this.db().prepare("SELECT id FROM task WHERE id = ?").get(body.id);
    if (exists) return this.view(body.id);
    const c = body.config;
    this.validate(c);
    const now = Date.now();
    const label = body.label || this.labelFor(c);
    this.db()
      .prepare("INSERT OR IGNORE INTO task(id, type, label, status, config, attempt, mint, state, created_at, updated_at) VALUES(?, ?, ?, 'IDLE', ?, 1, ?, ?, ?, ?)")
      .run(body.id, c.type, label, JSON.stringify(c), c.mint, JSON.stringify(fresh()), now, now);
    logActivity(this.db(), "auto.create", `Automatización «${label}» creada (${c.walletIds.length} wallets${c.includeDev ? ", incl. dev" : ""})`);
    if (body.start) return this.begin(body.id);
    return this.view(body.id);
  }

  /** Iniciar (desde IDLE) o Ejecutar de nuevo (desde un estado final, con una generación nueva y keys nuevas). */
  begin(id: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const t = this.load(id);
    const again = AUTO_FINAL.includes(t.status);
    if (t.status !== "IDLE" && !again) throw bad(t.status === "PAUSED" ? "La tarea está en pausa: usa Reanudar." : "La tarea ya está en marcha.", 409);
    this.validate(t.config);
    const now = this.clock();
    const c = t.config;
    const startAt = now + c.startDelaySec * 1000;
    const span = c.type === "dca" ? (c.end.kind !== "amount" ? c.end.durationSec : null) : c.expirySec;
    const state: AutoState = { ...fresh(), startAt, endsAt: span ? startAt + span * 1000 : null, nextAt: startAt };
    const gen = again ? t.attempt + 1 : t.attempt;
    this.db().prepare("UPDATE task SET status = 'RUNNING', attempt = ?, state = ?, updated_at = ? WHERE id = ?").run(gen, JSON.stringify(state), Date.now(), id);
    logActivity(this.db(), "auto.start", `«${t.label}» ${again ? `ejecutada de nuevo (intento ${gen})` : "iniciada"}`);
    return this.view(id);
  }

  pause(id: string) {
    const t = this.load(id);
    if (!this.transition(id, ["RUNNING"], "PAUSED")) throw bad("Solo se puede pausar una tarea en marcha.", 409);
    // no se envía nada más; lo que ya salió termina y se concilia al reanudar
    if (t.state.order) this.trading.halt(t.state.order.id);
    logActivity(this.db(), "auto.pause", `«${t.label}» en pausa`);
    return this.view(id);
  }

  /** REQ-AUTO-008: reanudar siempre es una acción explícita del operador. */
  resume(id: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const t = this.load(id);
    if (t.status !== "PAUSED") throw bad("Solo se puede reanudar una tarea en pausa.", 409);
    this.validate(t.config);
    const now = this.clock();
    // sin backlog: como mucho una ejecución ahora y luego se reprograma desde ella
    const st: AutoState = { ...t.state, waiting: null, nextAt: t.state.nextAt !== null && t.state.nextAt < now ? now : t.state.nextAt };
    this.save(id, st);
    this.transition(id, ["PAUSED"], "RUNNING");
    clearPaused(this.db(), [id]);
    logActivity(this.db(), "auto.resume", `«${t.label}» reanudada`);
    return this.view(id);
  }

  stopTask(id: string) {
    const t = this.load(id);
    if (!this.transition(id, ["IDLE", "RUNNING", "PAUSED"], "STOPPED")) throw bad("La tarea ya no está activa.", 409);
    clearPaused(this.db(), [id]);
    const st = { ...t.state, waiting: null, endReason: "Parada por el operador." };
    this.save(id, st);
    if (t.state.order) {
      const order = t.state.order;
      // lo que no llegó a enviarse queda omitido; lo ya ejecutado se suma al progreso
      void this.trading
        .cancel(order.id, "Automatización parada antes de enviar.")
        .then(() => this.settleCounts(id, order))
        .catch((e) => this.log(`Parar ${id}: ${(e as Error).message}`));
    }
    logActivity(this.db(), "auto.stop", `«${t.label}» parada`);
    return this.view(id);
  }

  /** Editar: solo en IDLE o en pausa (en caliente). Lo ya ejecutado se conserva. */
  edit(id: string, config: AutomationConfig, label?: string) {
    const t = this.load(id);
    if (t.status !== "IDLE" && t.status !== "PAUSED") throw bad("Solo se puede editar una tarea sin iniciar o en pausa.", 409);
    const c = config;
    if (c.type !== t.config.type || c.side !== t.config.side || c.mint !== t.config.mint) throw bad("El tipo, el lado y el token no se cambian: duplica la tarea para eso.", 409);
    this.validate(c);
    const st = { ...t.state };
    // una ejecución a medias sigue con sus wallets al reanudar: no se cambian por debajo (REQ-AUTO-010)
    if (st.order && (JSON.stringify([...c.walletIds].sort()) !== JSON.stringify([...t.config.walletIds].sort()) || c.includeDev !== t.config.includeDev)) throw bad("Hay una ejecución a medias con las wallets actuales: reanúdala o para la tarea antes de cambiar las wallets.", 409);
    if (c.type === "limit" && t.config.type === "limit" && st.fired > 0) {
      const old = t.config.targets.slice(0, st.fired);
      if (c.targets.length < st.fired || old.some((o, i) => JSON.stringify(o) !== JSON.stringify(c.targets[i]))) throw bad(`Los ${st.fired} primeros objetivos ya se ejecutaron y no se pueden cambiar.`, 409);
    }
    if (t.status === "PAUSED" && st.startAt !== null) {
      const span = c.type === "dca" ? (c.end.kind !== "amount" ? c.end.durationSec : null) : c.expirySec;
      st.endsAt = span ? st.startAt + span * 1000 : null;
    }
    this.db().prepare("UPDATE task SET config = ?, label = ?, state = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(c), label || t.label, JSON.stringify(st), Date.now(), id);
    logActivity(this.db(), "auto.edit", `«${t.label}» editada${t.status === "PAUSED" ? " en pausa" : ""}`);
    return this.view(id);
  }

  duplicate(id: string) {
    const t = this.load(id);
    const nid = randomUUID();
    const now = Date.now();
    this.db()
      .prepare("INSERT INTO task(id, type, label, status, config, attempt, mint, state, created_at, updated_at) VALUES(?, ?, ?, 'IDLE', ?, 1, ?, ?, ?, ?)")
      .run(nid, t.type, `${t.label} (copia)`.slice(0, 80), JSON.stringify(t.config), t.mint, JSON.stringify(fresh()), now, now);
    logActivity(this.db(), "auto.duplicate", `«${t.label}» duplicada`);
    return this.view(nid);
  }

  /** Borrar solo una tarea parada (sin iniciar, parada o terminada); nunca una en marcha o en pausa. */
  remove(id: string) {
    const t = this.load(id);
    if (t.status === "RUNNING" || t.status === "PAUSED") throw bad("Para la tarea antes de borrarla.", 409);
    this.db().prepare("DELETE FROM task WHERE id = ?").run(id);
    clearPaused(this.db(), [id]);
    logActivity(this.db(), "auto.delete", `«${t.label}» borrada`);
    return { ok: true };
  }

  /** Espera a que el motor no esté trabajando en la tarea (tests). */
  async waitIdle(id: string, timeoutMs = 120_000) {
    const t0 = Date.now();
    while (this.running.has(id) && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 25));
    return this.view(id);
  }

  // ── motor ───────────────────────────────────────────────
  tick() {
    if (!this.vault.isUnlocked()) return;
    let ids: { id: string }[];
    try {
      ids = this.db().prepare("SELECT id FROM task WHERE status = 'RUNNING'").all() as { id: string }[];
    } catch {
      return; // base de datos cerrada (restauración)
    }
    for (const { id } of ids) if (!this.running.has(id)) void this.step(id);
  }

  private async step(id: string) {
    this.running.add(id);
    try {
      await this.advance(id);
    } catch (e) {
      if (e instanceof VaultError && e.code === "LOCKED") return;
      this.log(`Automatización ${id}: ${(e as Error).message}`);
      try {
        const t = this.load(id);
        this.save(id, { ...t.state, waiting: `Reintentando: ${(e as Error).message}`, nextAt: this.clock() + ERROR_BACKOFF_MS });
      } catch {}
    } finally {
      this.running.delete(id);
    }
  }

  private wait(t: Task, why: string | null, extra: Partial<AutoState> = {}) {
    if (t.state.waiting === why && Object.keys(extra).length === 0) return;
    this.save(t.id, { ...t.state, waiting: why, ...extra });
  }

  private end(t: Task, status: AutoStatus, reason: string) {
    if (!this.transition(t.id, ["RUNNING"], status)) return;
    const st = this.load(t.id).state;
    this.save(t.id, { ...st, waiting: null, endReason: reason });
    // una orden a medias (p. ej. tras reintentos fallidos) se cierra: lo no enviado queda omitido
    if (st.order) {
      const order = st.order;
      void this.trading
        .cancel(order.id, `Automatización terminada: ${reason}`)
        .then(() => this.settleCounts(t.id, order))
        .catch((e) => this.log(`Cerrar ${t.id}: ${(e as Error).message}`));
    }
    logActivity(this.db(), "auto.end", `«${t.label}»: ${reason}`);
  }

  private async advance(id: string) {
    const t = this.load(id);
    if (t.status !== "RUNNING") return;
    const now = this.clock();
    if (t.state.order) {
      if (t.state.nextAt !== null && now < t.state.nextAt && t.state.waiting?.startsWith("Reintentando")) return;
      return this.runOrder(t, t.state.order);
    }
    const c = t.config;
    const st = t.state;
    if (st.endsAt !== null && now >= st.endsAt) {
      if (c.type === "dca") return this.end(t, "COMPLETED", "Duración cumplida.");
      return this.end(t, "TIMEOUT", `Caducó con ${st.fired} de ${c.targets.length} objetivos ejecutados.`);
    }
    if (st.startAt !== null && now < st.startAt) return this.wait(t, "Retardo de inicio");
    if (st.nextAt !== null && now < st.nextAt) return st.waiting?.startsWith("Retardo") ? this.wait(t, null) : undefined;

    let remaining: bigint | null = null;
    if (c.type === "dca" && c.end.kind !== "duration") {
      remaining = BigInt(c.end.totalAmount!) - BigInt(st.spent);
      if (remaining <= 0n) return this.end(t, "COMPLETED", "Monto total alcanzado.");
    }
    if (c.type === "limit" && st.fired >= c.targets.length) return this.end(t, "COMPLETED", "Todos los objetivos ejecutados.");

    // market cap del indexer + Pyth
    const m = await this.live.market(t.mint);
    const mcUsd = m.mcUsd;
    if (m.info.venue === "migrating") return this.wait(t, "Migración a PumpSwap en curso", { mcUsd });
    const needPrice = c.type === "limit" || c.mcMinUsd !== null || c.mcMaxUsd !== null;
    if (needPrice && mcUsd === null) return this.wait(t, "Sin precio SOL/USD vigente (Pyth)", { mcUsd });
    if (mcUsd !== null && ((c.mcMinUsd !== null && mcUsd < c.mcMinUsd) || (c.mcMaxUsd !== null && mcUsd > c.mcMaxUsd))) return this.wait(t, `Market cap ${fmtUsd(mcUsd)} fuera del rango`, { mcUsd });

    const n = c.walletIds.length;
    let body: InternalOrder;
    const orderId = `auto-${t.id}-${t.attempt}-${st.seq}`;
    let target: number | null = null;
    const baseOrder = { id: orderId, mint: t.mint, side: c.side, walletIds: c.walletIds, slippagePct: c.slippagePct, mode: c.mode, source: "auto" as const, taskId: t.id, label: t.label };
    if (c.type === "dca") {
      let each = dcaPlan(c, n).amountAt(st.seq);
      if (remaining !== null && each * BigInt(n) > remaining) each = remaining / BigInt(n);
      if (each <= 0n) return this.end(t, "COMPLETED", "Monto total alcanzado.");
      body = c.side === "buy" ? { ...baseOrder, lamportsEach: each.toString() } : { ...baseOrder, tokensEach: each.toString() };
    } else {
      target = st.fired;
      const tg = c.targets[target];
      const hit = c.side === "buy" ? mcUsd! <= tg.mcUsd : mcUsd! >= tg.mcUsd;
      if (!hit) return this.wait(t, `Esperando ${c.side === "buy" ? "≤" : "≥"} ${fmtUsd(tg.mcUsd)} (ahora ${fmtUsd(mcUsd!)})`, { mcUsd });
      body = c.side === "buy" ? { ...baseOrder, lamportsEach: tg.lamportsEach! } : { ...baseOrder, pct: tg.pct! };
    }
    const ref: OrderRef = { id: orderId, seq: st.seq, target, body };
    // se apunta ANTES de crear la orden: tras un cierre se reanuda esta misma (mismas keys)
    this.save(t.id, { ...st, order: ref, waiting: null, mcUsd });
    this.db().prepare("INSERT OR IGNORE INTO task_run(task_id, generation, seq, order_id, target, mc_usd, at) VALUES(?, ?, ?, ?, ?, ?, ?)").run(t.id, t.attempt, st.seq, orderId, target, mcUsd, Date.now());
    return this.runOrder(this.load(t.id), ref);
  }

  /** Crea (o reanuda) la orden hija, espera su resultado y lo aplica a la tarea. */
  private async runOrder(t: Task, ref: OrderRef) {
    let v: ReturnType<Trading["view"]> | null = null;
    try {
      v = this.trading.view(ref.id);
    } catch {}
    try {
      if (!v) v = await this.trading.create(ref.body);
      else if (v.status === "PAUSED") v = await this.trading.resume(ref.id, true);
    } catch (e) {
      if (e instanceof VaultError && e.code === "LOCKED") return;
      const code = (e as { code?: string }).code;
      // no se llegó a crear: se suelta la ejecución para volver a evaluarla
      this.save(t.id, { ...this.load(t.id).state, order: null, waiting: code === "MIGRATING" ? "Migración a PumpSwap en curso" : `Reintentando: ${(e as Error).message}`, nextAt: this.clock() + ERROR_BACKOFF_MS });
      this.db().prepare("DELETE FROM task_run WHERE task_id = ? AND order_id = ?").run(t.id, ref.id);
      if (code !== "MIGRATING") this.countError(t.id, (e as Error).message);
      return;
    }
    v = await this.trading.waitIdle(ref.id, 10 * 60_000);
    const now = this.clock();
    const cur = this.load(t.id);
    if (v.status === "RUNNING" || v.status === "PAUSED") {
      if (cur.status !== "RUNNING") return; // la pausó el operador o el bloqueo: se retoma al reanudar
      const pend = v.items.filter((i) => i.status === "PENDING");
      // Error ANTES de enviar (lectura del RPC, construcción): no salió nada, así que se reintenta la misma
      // orden tras una espera y cuenta como error seguido. Un envío pendiente, en cambio, pausa la tarea.
      if (pend.length > 0 && pend.every((i) => i.reason?.startsWith("En pausa:") && !i.signature)) {
        const why = pend[0].reason!.replace(/^En pausa: /, "");
        this.save(t.id, { ...cur.state, waiting: `Reintentando: ${why}`, nextAt: now + ERROR_BACKOFF_MS });
        this.countError(t.id, why);
        return;
      }
      if (this.transition(t.id, ["RUNNING"], "PAUSED")) {
        const why = v.items.find((i) => i.status === "PENDING")?.reason ?? "Envío pendiente de confirmar";
        this.save(t.id, { ...cur.state, lastError: why, waiting: null });
        const list = pausedList(this.db());
        if (!list.some((p) => p.id === t.id)) kvSet(this.db(), "paused", JSON.stringify([...list, { id: t.id, kind: "automatización", label: cur.label }]));
        logActivity(this.db(), "auto.pause", `«${cur.label}» en pausa: ${why}`);
      }
      return;
    }
    // orden terminada (COMPLETED, PARTIAL o FAILED)
    const ok = v.items.filter((i) => i.status === "OK");
    const sum = ok.reduce((a, i) => a + BigInt(i.amount ?? "0"), 0n);
    const st: AutoState = { ...cur.state, order: null, seq: ref.seq + 1, spent: (BigInt(cur.state.spent) + sum).toString() };
    const c = cur.config;
    if (ok.length > 0) {
      st.consecErrors = 0;
      st.lastError = null;
      if (c.type === "limit") st.fired = (ref.target ?? st.fired) + 1;
    } else {
      st.consecErrors += 1;
      st.lastError = v.items.map((i) => i.reason).find(Boolean) ?? "Ninguna wallet entró.";
    }
    st.nextAt = c.type === "dca" ? now + c.intervalSec * 1000 : ok.length > 0 ? now : now + LIMIT_RETRY_MS;
    this.save(t.id, st);
    if (cur.status !== "RUNNING") return; // pausada o parada mientras terminaba: no se encadena nada
    const next = this.load(t.id);
    if (st.consecErrors >= c.maxErrors) return this.end(next, "FAILED", `Parada tras ${st.consecErrors} ejecuciones seguidas sin entrar: ${st.lastError}`);
    if (c.type === "dca" && c.end.kind !== "duration" && BigInt(st.spent) >= BigInt(c.end.totalAmount!)) return this.end(next, "COMPLETED", "Monto total alcanzado.");
    if (c.type === "limit" && st.fired >= c.targets.length) return this.end(next, "COMPLETED", "Todos los objetivos ejecutados.");
  }

  private countError(id: string, message: string) {
    const t = this.load(id);
    const st = { ...t.state, consecErrors: t.state.consecErrors + 1, lastError: message };
    this.save(id, st);
    if (st.consecErrors >= t.config.maxErrors) this.end(this.load(id), "FAILED", `Parada tras ${st.consecErrors} errores seguidos: ${message}`);
  }

  /** Tras parar con una orden en curso: suma lo que sí entró y suelta la orden. */
  private settleCounts(id: string, ref: OrderRef) {
    let t: Task;
    try {
      t = this.load(id);
    } catch {
      return;
    }
    if (t.state.order?.id !== ref.id) return;
    const v = this.trading.view(ref.id);
    const sum = v.items.filter((i) => i.status === "OK").reduce((a, i) => a + BigInt(i.amount ?? "0"), 0n);
    this.save(id, { ...t.state, order: null, seq: ref.seq + 1, spent: (BigInt(t.state.spent) + sum).toString(), fired: t.config.type === "limit" && sum > 0n ? (ref.target ?? t.state.fired) + 1 : t.state.fired });
  }
}
