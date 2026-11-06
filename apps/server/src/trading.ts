// REQ-LIVE-002/003: comprar y vender desde una, varias o todas las wallets, en la curva o en PumpSwap.
// El cliente aporta el id de la orden (un doble clic no duplica nada) y cada wallet usa la idempotency key
// trade:<orden>:<wallet>. Resultado por wallet: entró (OK), falló (FAILED) u omitida (SKIPPED), con motivo.
// Un envío `pending` deja la wallet pendiente y la orden en pausa: nunca se marca como fallida.
// "Escalonado" = una wallet tras otra con un retardo FIJO (sin aleatoriedad: §2.3 de la spec).
import { z } from "zod";
import type { DB } from "./db";
import { kvGet, kvSet, logActivity } from "./db";
import type { Vault } from "./signer";
import { VaultError } from "./signer";
import type { ChainManager } from "./chain-manager";
import type { Live } from "./live";
import { txFee } from "./chain/fees";

export const STAGGER_MS = 800;
const PARALLEL = 6;
/** margen que el MAX deja en cada wallet además de fees y rent (REQ-COST-002) */
const MAX_BUFFER = 1_000_000n;
const CU_LIMIT = 400_000;
const bps = (pct: number) => BigInt(Math.round(pct * 100));
/** compra mínima con la que se mide el coste fijo en PumpSwap */
const PROBE_LAMPORTS = 1_000_000n;
const WSOL_RENT = 2_039_280n;
/**
 * SOL que la compra necesita tener la wallet durante la tx. En PumpSwap el SDK puede envolver en WSOL el
 * máximo con slippage (`maxQuote`, medido en Surfpool justo tras migrar) y devuelve lo que sobra al cerrar
 * la cuenta; en la curva se cobra el coste real. Se reserva el caso peor.
 */
export const heldForBuy = (lamports: bigint, venue: string, slippagePct: number) => (venue === "pumpswap" ? (lamports * (10_000n + bps(slippagePct))) / 10_000n + 1n : lamports);

const base = {
  mint: z.string().min(32).max(64),
  side: z.enum(["buy", "sell"]),
  walletIds: z.array(z.string()).min(1).max(100),
  lamportsEach: z.string().regex(/^\d+$/).optional(),
  pct: z.number().min(1).max(100).optional(),
  slippagePct: z.number().min(0.1).max(50),
};
export const QuoteInput = z.object(base);
export const OrderInput = z.object({ ...base, id: z.string().uuid(), mode: z.enum(["parallel", "staggered"]).default("parallel"), source: z.enum(["ticket", "instant"]).default("ticket") });
export type OrderInput = z.infer<typeof OrderInput>;
/**
 * Orden creada por el servidor (REQ-AUTO): `taskId` la ata a su automatización, que es quien la pausa y la
 * reanuda (no entra en la lista de pausadas por su cuenta). `tokensEach`: venta de un número fijo de tokens
 * por wallet, recortado a su saldo.
 */
export type InternalOrder = Omit<OrderInput, "source"> & { source: "ticket" | "instant" | "auto"; taskId?: string; tokensEach?: string; label?: string };

type ItemStatus = "PENDING" | "OK" | "FAILED" | "SKIPPED";
type W = { id: string; label: string; address: string };

export class Trading {
  private running = new Set<string>();

  constructor(
    private db: () => DB,
    private chain: ChainManager,
    private vault: Vault,
    private live: Live,
    private priority: () => number,
    private log: (m: string) => void,
  ) {}

  private walletsOf(ids: string[]) {
    const get = this.db().prepare("SELECT id, label, address FROM wallet WHERE id = ? AND archived = 0 AND kind = 'wallet'");
    const out: W[] = [];
    for (const id of [...new Set(ids)]) {
      const w = get.get(id) as W | undefined;
      if (!w) throw Object.assign(new Error("Una de las wallets no existe o está archivada."), { statusCode: 400 });
      out.push(w);
    }
    return out;
  }

  private fee() {
    return txFee(1, CU_LIMIT, this.priority());
  }

  /** REQ-COST-001/002: vista previa por wallet con el desglose de costes y el MAX que reserva fees y rent. */
  async quote(input: z.infer<typeof QuoteInput>) {
    const chain = this.chain.get();
    const wallets = this.walletsOf(input.walletIds);
    const info = await chain.adapter.tokenInfo(input.mint);
    const addrs = wallets.map((w) => w.address);
    const tradable = info.venue !== "migrating";
    const [sol, tok, rent] = await Promise.all([chain.reader.balances(addrs), chain.reader.tokenBalances(input.mint, addrs), chain.reader.tokenAccountRent(input.mint)]);
    // rent de las cuentas que creará cada compra (token, volumen y, en PumpSwap, la WSOL temporal)
    const extra = new Map<string, bigint>();
    if (tradable) for (const w of wallets) extra.set(w.address, await chain.adapter.tradeAccountsRent({ mint: input.mint, user: w.address, side: input.side }));
    const fee = this.fee();
    const network = 5_000n;
    // En PumpSwap el coste fijo de la primera compra (cuentas nuevas, ampliación del pool tras migrar…)
    // depende del estado del programa: se mide simulando una compra mínima y leyendo el saldo posterior.
    // La WSOL temporal se cierra en la misma tx, así que su rent no aparece en la diferencia y se suma aparte.
    const measured = new Map<string, bigint>();
    if (tradable && input.side === "buy" && info.venue === "pumpswap") {
      for (const w of wallets) {
        const bal = sol.get(w.address) ?? 0n;
        if (bal < PROBE_LAMPORTS * 3n) continue;
        const probe = await chain.adapter.buildBuyTx({ mint: input.mint, user: w.address, lamports: PROBE_LAMPORTS, slippagePct: input.slippagePct }).catch(() => null);
        const sim = probe ? await chain.sender.send(probe, { idempotencyKey: `trade-quote:${Date.now()}:${w.id}`, simulateOnly: true, watch: w.address }) : null;
        if (sim?.status === "simulated" && sim.postLamports !== undefined) measured.set(w.address, bal - sim.postLamports - PROBE_LAMPORTS + WSOL_RENT);
      }
    }
    // fee incluida en lo medido; si no se pudo medir, la estimación de cuentas nuevas
    const reserveOf = (w: W) => (measured.has(w.address) ? measured.get(w.address)! : fee + (extra.get(w.address) ?? 0n)) + MAX_BUFFER;
    // MAX: lo que cabe en la wallet más justa tras reservar fees, rent de cuentas nuevas y un margen;
    // en PumpSwap, además, el margen de slippage que se envuelve en WSOL durante la tx
    const toMax = (room: bigint) => (info.venue === "pumpswap" ? (room * 10_000n) / (10_000n + bps(input.slippagePct)) - 1n : room);
    const maxBuy = wallets.length ? wallets.map((w) => toMax((sol.get(w.address) ?? 0n) - reserveOf(w))).reduce((a, b) => (b < a ? b : a)) : 0n;
    const items: { walletId: string; label: string; ok: boolean; reason?: string; amountIn: string; expectedOut: string; limit: string }[] = [];
    let volume = 0n;
    let rentTotal = 0n;
    for (const w of wallets) {
      const s = sol.get(w.address) ?? 0n;
      const t = tok.get(w.address) ?? 0n;
      let amount = 0n;
      let reason: string | undefined;
      if (input.side === "buy") {
        amount = BigInt(input.lamportsEach ?? "0");
        const need = heldForBuy(amount, info.venue, input.slippagePct) + fee + (extra.get(w.address) ?? 0n);
        if (amount <= 0n) reason = "Monto 0.";
        else if (s < need) reason = `Saldo insuficiente: tiene ${(Number(s) / 1e9).toFixed(4)} SOL y necesita ${(Number(need) / 1e9).toFixed(4)} (monto + fees + rent).`;
      } else {
        amount = (t * BigInt(Math.round((input.pct ?? 100) * 100))) / 10_000n;
        if (amount <= 0n) reason = "Sin tokens de este token.";
        else if (s < fee + (extra.get(w.address) ?? 0n)) reason = "Sin SOL para la fee de red y el rent de la operación.";
      }
      let expectedOut = 0n;
      let limit = 0n;
      if (!reason && tradable) {
        const q = await chain.adapter.quote({ mint: input.mint, side: input.side, amount, slippagePct: input.slippagePct });
        expectedOut = q.amountOut;
        limit = q.limit;
        volume += input.side === "buy" ? amount : q.amountOut;
        if (input.side === "buy") rentTotal += extra.get(w.address) ?? 0n;
      }
      items.push({ walletId: w.id, label: w.label, ok: !reason, reason, amountIn: amount.toString(), expectedOut: expectedOut.toString(), limit: limit.toString() });
    }
    const n = BigInt(items.filter((i) => i.ok).length);
    const padFee = (volume * BigInt(info.padFeeBps)) / 10_000n;
    return {
      venue: info.venue,
      padFeeBps: info.padFeeBps,
      items,
      costs: {
        volume: volume.toString(),
        network: (network * n).toString(),
        priority: ((fee - network) * n).toString(),
        rent: rentTotal.toString(),
        padFee: padFee.toString(),
        // compra: lo que sale de las wallets; venta: solo el coste de la operación
        total: (input.side === "buy" ? volume + fee * n + rentTotal : fee * n).toString(),
      },
      maxBuyPerWallet: (maxBuy > 0n ? maxBuy : 0n).toString(),
      rentPerAccount: rent.toString(),
      feePerTx: fee.toString(),
    };
  }

  view(id: string) {
    const o = this.db().prepare("SELECT * FROM trade_order WHERE id = ?").get(id) as { id: string; mint: string; side: string; status: string; config: string; created_at: number; updated_at: number } | undefined;
    if (!o) throw Object.assign(new Error("Orden no encontrada"), { statusCode: 404 });
    const items = this.db()
      .prepare("SELECT i.ord, i.wallet_id AS walletId, w.label, w.address, i.status, i.amount, i.result, i.signature, i.reason, MAX(i.attempts - 1, 0) AS retries FROM trade_order_item i LEFT JOIN wallet w ON w.id = i.wallet_id WHERE i.order_id = ? ORDER BY i.ord")
      .all(id) as { ord: number; walletId: string; label: string; address: string; status: ItemStatus; amount: string | null; result: string | null; signature: string | null; reason: string | null; retries: number }[];
    const cfg = JSON.parse(o.config) as InternalOrder;
    return { id: o.id, mint: o.mint, side: o.side, status: o.status, mode: cfg.mode, source: cfg.source, slippagePct: cfg.slippagePct, lamportsEach: cfg.lamportsEach ?? null, pct: cfg.pct ?? null, tokensEach: cfg.tokensEach ?? null, taskId: cfg.taskId ?? null, items, createdAt: o.created_at, updatedAt: o.updated_at };
  }

  /** Crea y lanza la orden. Repetir con el mismo id devuelve la misma orden (doble clic). */
  async create(input: OrderInput | InternalOrder) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const existing = this.db().prepare("SELECT id FROM trade_order WHERE id = ?").get(input.id);
    if (existing) return this.view(input.id);
    if (input.side === "buy" && !(BigInt(input.lamportsEach ?? "0") > 0n)) throw Object.assign(new Error("Indica el SOL por wallet."), { statusCode: 400 });
    if (input.side === "sell" && !input.pct && !("tokensEach" in input && input.tokensEach && BigInt(input.tokensEach) > 0n)) throw Object.assign(new Error("Indica el porcentaje a vender."), { statusCode: 400 });
    const wallets = this.walletsOf(input.walletIds);
    const info = await this.chain.get().adapter.tokenInfo(input.mint);
    if (info.venue === "migrating") throw Object.assign(new Error("La curva está completa y la migración a PumpSwap aún no ha ocurrido. Espera a que exista el pool."), { statusCode: 409, code: "MIGRATING" });
    const db = this.db();
    const now = Date.now();
    db.transaction(() => {
      // INSERT OR IGNORE: dos peticiones simultáneas con el mismo id crean una sola orden
      const r = db.prepare("INSERT OR IGNORE INTO trade_order(id, mint, side, status, config, created_at, updated_at) VALUES(?, ?, ?, 'RUNNING', ?, ?, ?)").run(input.id, input.mint, input.side, JSON.stringify(input), now, now);
      if (!r.changes) return;
      const ins = db.prepare("INSERT INTO trade_order_item(order_id, ord, wallet_id, status, amount) VALUES(?, ?, ?, 'PENDING', ?)");
      wallets.forEach((w, i) => ins.run(input.id, i, w.id, input.side === "buy" ? input.lamportsEach! : null));
    })();
    const sellDesc = "tokensEach" in input && input.tokensEach ? `${input.tokensEach} unidades por wallet` : `${input.pct} %`;
    const via = input.source === "instant" ? "Instant Trade" : input.source === "auto" ? `automatización${"label" in input && input.label ? ` «${input.label}»` : ""}` : "ticket";
    logActivity(db, `trade.${input.side}`, `${input.side === "buy" ? "Compra" : "Venta"} (${via}, ${input.mode === "parallel" ? "en paralelo" : "escalonada"}) en ${wallets.length} wallets · ${input.side === "buy" ? `${Number(input.lamportsEach) / 1e9} SOL por wallet` : sellDesc} · mint ${input.mint}`);
    void this.run(input.id);
    return this.view(input.id);
  }

  async resume(id: string, internal = false) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const v = this.view(id);
    if (v.taskId && !internal) throw Object.assign(new Error("Esta orden pertenece a una automatización: se reanuda desde la tarea."), { statusCode: 409 });
    if (v.status !== "PAUSED") return v;
    this.db().prepare("UPDATE trade_order SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(Date.now(), id);
    void this.run(id);
    return this.view(id);
  }

  async waitIdle(id: string, timeoutMs = 120_000) {
    const t = Date.now();
    while (this.running.has(id) && Date.now() - t < timeoutMs) await new Promise((r) => setTimeout(r, 50));
    return this.view(id);
  }

  private status(id: string) {
    return (this.db().prepare("SELECT status FROM trade_order WHERE id = ?").get(id) as { status: string } | undefined)?.status;
  }

  private async run(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const o = this.db().prepare("SELECT mint, config FROM trade_order WHERE id = ?").get(id) as { mint: string; config: string };
      const cfg = JSON.parse(o.config) as InternalOrder;
      const items = this.db().prepare("SELECT ord, wallet_id, amount FROM trade_order_item WHERE order_id = ? AND status = 'PENDING' ORDER BY ord").all(id) as { ord: number; wallet_id: string; amount: string | null }[];
      let pause: string | null = null;
      const one = async (it: (typeof items)[number]) => {
        if (pause || this.status(id) !== "RUNNING") return;
        const r = await this.item(id, o.mint, cfg, it);
        if (r) pause ??= r;
      };
      if (cfg.mode === "staggered") {
        for (let i = 0; i < items.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_MS));
          await one(items[i]);
        }
      } else {
        for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(one));
      }
      if (pause) return this.pause(id);
      if (this.status(id) === "RUNNING") this.finish(id);
    } catch (e) {
      this.log(`Orden ${id} interrumpida: ${(e as Error).message}`);
      this.pause(id);
    } finally {
      this.running.delete(id);
      const mint = (this.db().prepare("SELECT mint FROM trade_order WHERE id = ?").get(id) as { mint: string } | undefined)?.mint;
      if (mint) void this.live.refresh(mint).catch(() => {});
    }
  }

  /** Ejecuta una wallet. Devuelve un motivo si la orden debe pausarse. */
  private async item(id: string, mint: string, cfg: InternalOrder, it: { ord: number; wallet_id: string; amount: string | null }): Promise<string | null> {
    const chain = this.chain.get();
    const upd = this.db().prepare("UPDATE trade_order_item SET status = ?, amount = COALESCE(?, amount), result = ?, signature = ?, reason = ? WHERE order_id = ? AND ord = ?");
    const w = this.db().prepare("SELECT address FROM wallet WHERE id = ?").get(it.wallet_id) as { address: string } | undefined;
    if (!w) return void upd.run("SKIPPED", null, null, null, "La wallet ya no existe.", id, it.ord), null;
    const key = `trade:${id}:${it.wallet_id}`;
    // REQ-AUTO-007: cada paso por la wallet cuenta; los reintentos son los pasos tras el primero
    this.db().prepare("UPDATE trade_order_item SET attempts = attempts + 1 WHERE order_id = ? AND ord = ?").run(id, it.ord);
    const sent = this.db().prepare("SELECT status FROM tx WHERE idempotency_key = ?").get(key) as { status: string } | undefined;
    try {
      const [sol, tok] = await Promise.all([chain.reader.balances([w.address]), chain.reader.tokenBalance(mint, w.address)]);
      const s = sol.get(w.address) ?? 0n;
      let amount: bigint;
      if (cfg.side === "buy") {
        amount = BigInt(it.amount ?? cfg.lamportsEach!);
        // Comprobación previa solo si aún no se envió nada con esta key (tras un pending, el saldo ya bajó)
        if (!sent) {
          const venue = (await chain.adapter.tokenInfo(mint)).venue;
          const need = heldForBuy(amount, venue, cfg.slippagePct) + this.fee() + (await chain.adapter.tradeAccountsRent({ mint, user: w.address, side: "buy" }));
          if (s < need) return void upd.run("SKIPPED", null, null, null, `Saldo insuficiente: tiene ${(Number(s) / 1e9).toFixed(4)} SOL y necesita ${(Number(need) / 1e9).toFixed(4)} (monto + fees + rent).`, id, it.ord), null;
        }
      } else {
        // Venta: los tokens salen del saldo en cadena al ejecutar y se guardan ANTES de enviar
        // `tokensEach` (automatizaciones): número fijo de tokens, recortado al saldo de la wallet
        amount = it.amount ? BigInt(it.amount) : cfg.tokensEach ? (BigInt(cfg.tokensEach) < tok ? BigInt(cfg.tokensEach) : tok) : (tok * BigInt(Math.round((cfg.pct ?? 100) * 100))) / 10_000n;
        if (!it.amount) {
          if (amount <= 0n) return void upd.run("SKIPPED", null, null, null, "Sin tokens de este token.", id, it.ord), null;
          if (s < this.fee() + (await chain.adapter.tradeAccountsRent({ mint, user: w.address, side: "sell" }))) return void upd.run("SKIPPED", null, null, null, "Sin SOL para la fee de red y el rent de la operación.", id, it.ord), null;
          this.db().prepare("UPDATE trade_order_item SET amount = ? WHERE order_id = ? AND ord = ?").run(amount.toString(), id, it.ord);
        }
      }
      let tx;
      try {
        tx = cfg.side === "buy" ? await chain.adapter.buildBuyTx({ mint, user: w.address, lamports: amount, slippagePct: cfg.slippagePct }) : await chain.adapter.buildSellTx({ mint, user: w.address, tokens: amount, slippagePct: cfg.slippagePct });
      } catch (e) {
        if ((e as { code?: string }).code === "MIGRATING") return void upd.run("FAILED", null, null, null, (e as Error).message, id, it.ord), null;
        throw e;
      }
      const res = await chain.sender.send(tx, { idempotencyKey: key });
      if (res.status === "confirmed") {
        // Resultado real leído de la cadena: tokens recibidos (compra) o SOL neto recibido (venta)
        const [sol2, tok2] = await Promise.all([chain.reader.balances([w.address]), chain.reader.tokenBalance(mint, w.address)]);
        const result = cfg.side === "buy" ? tok2 - tok : (sol2.get(w.address) ?? 0n) - s;
        // Si ya se había enviado antes (reanudación), la diferencia de saldos de ahora no es el resultado
        upd.run("OK", null, sent || res.reused ? null : result.toString(), res.signature, null, id, it.ord);
        return null;
      }
      if (res.status === "pending") {
        upd.run("PENDING", null, null, res.signature ?? null, res.message, id, it.ord);
        return res.message;
      }
      if (res.status === "failed") {
        if (res.code === "UNKNOWN") return res.message;
        upd.run("FAILED", null, null, res.signature ?? null, res.message, id, it.ord);
      }
      return null;
    } catch (e) {
      if (e instanceof VaultError && e.code === "LOCKED") return "Bóveda bloqueada";
      if (e instanceof VaultError && e.code === "NO_KEY") return void upd.run("FAILED", null, null, null, e.message, id, it.ord), null;
      // Error inesperado (RPC, construcción): la wallet sigue pendiente con el motivo y la orden se pausa
      this.db().prepare("UPDATE trade_order_item SET reason = ? WHERE order_id = ? AND ord = ?").run(`En pausa: ${(e as Error).message}`, id, it.ord);
      return (e as Error).message;
    }
  }

  private finish(id: string) {
    const rows = this.db().prepare("SELECT status FROM trade_order_item WHERE order_id = ?").all(id) as { status: ItemStatus }[];
    const ok = rows.filter((r) => r.status === "OK").length;
    const failed = rows.filter((r) => r.status === "FAILED").length;
    const skipped = rows.filter((r) => r.status === "SKIPPED").length;
    const status = ok === rows.length ? "COMPLETED" : ok === 0 ? "FAILED" : "PARTIAL";
    this.db().prepare("UPDATE trade_order SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
    logActivity(this.db(), "trade.done", `Orden ${id.slice(0, 8)}: ${ok} entraron, ${failed} fallaron, ${skipped} omitidas`);
  }

  private pause(id: string) {
    const r = this.db().prepare("UPDATE trade_order SET status = 'PAUSED', updated_at = ? WHERE id = ? AND status = 'RUNNING'").run(Date.now(), id);
    if (!r.changes) return;
    const v = this.view(id);
    if (v.taskId) return; // la pausa la gestiona su automatización
    const list = JSON.parse(kvGet(this.db(), "paused") ?? "[]") as { id: string; kind: string; label: string }[];
    if (!list.some((p) => p.id === id)) kvSet(this.db(), "paused", JSON.stringify([...list, { id, kind: "orden", label: `${v.side === "buy" ? "Compra" : "Venta"} en ${v.items.length} wallets` }]));
  }

  /** La automatización pausa o para su orden: no se envía nada más (lo ya emitido termina). */
  halt(id: string) {
    this.db().prepare("UPDATE trade_order SET status = 'PAUSED', updated_at = ? WHERE id = ? AND status = 'RUNNING'").run(Date.now(), id);
  }

  /** Tarea parada: lo que no llegó a enviarse queda omitido con el motivo y la orden se cierra. */
  async cancel(id: string, reason: string) {
    this.halt(id);
    await this.waitIdle(id, 60_000);
    const db = this.db();
    const items = db.prepare("SELECT ord, wallet_id FROM trade_order_item WHERE order_id = ? AND status = 'PENDING'").all(id) as { ord: number; wallet_id: string }[];
    for (const it of items) {
      const sent = db.prepare("SELECT status FROM tx WHERE idempotency_key = ?").get(`trade:${id}:${it.wallet_id}`) as { status: string } | undefined;
      // un envío ya emitido (SENT) se queda pendiente: la conciliación con la cadena dirá si entró
      if (sent?.status === "CONFIRMED") db.prepare("UPDATE trade_order_item SET status = 'OK', reason = NULL WHERE order_id = ? AND ord = ?").run(id, it.ord);
      else if (!sent || sent.status === "FAILED" || sent.status === "EXPIRED") db.prepare("UPDATE trade_order_item SET status = 'SKIPPED', reason = ? WHERE order_id = ? AND ord = ?").run(reason, id, it.ord);
    }
    if (this.status(id) === "PAUSED") this.finish(id);
  }

  /** Al bloquear o reiniciar: lo RUNNING pasa a PAUSED y solo se reanuda con confirmación (REQ-AUTO-008). */
  pauseAllRunning() {
    const ids = this.db().prepare("SELECT id FROM trade_order WHERE status = 'RUNNING'").all() as { id: string }[];
    for (const { id } of ids) this.pause(id);
    return ids.length;
  }
}
