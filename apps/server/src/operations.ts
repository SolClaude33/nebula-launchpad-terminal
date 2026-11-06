// REQ-WAL-008 / REQ-FUND-003: movimientos de SOL como operaciones del servidor.
// preview → guarda el plan; execute → ejecuta ESE plan; cada tx usa la idempotency key op:<id>:<chunk>.
// Al bloquear o reiniciar, lo RUNNING pasa a PAUSED y se reanuda solo con confirmación.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db";
import { kvGet, kvSet, logActivity } from "./db";
import type { Vault } from "./signer";
import { VaultError } from "./signer";
import type { ChainManager } from "./chain-manager";
import { isOnCurve, isValidAddress } from "./chain/transfers";
import type { PreparedTx } from "./chain/types";

export const OperationInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transfer"), fromId: z.string(), to: z.string().trim(), lamports: z.string().regex(/^\d+$/).optional(), max: z.boolean().optional() }),
  z.object({ kind: z.literal("disperse"), fromId: z.string(), toIds: z.array(z.string()).min(1).max(500), lamportsEach: z.string().regex(/^\d+$/) }),
  z.object({ kind: z.literal("collect"), fromIds: z.array(z.string()).min(1).max(500), toId: z.string() }),
]);
export type OperationInput = z.infer<typeof OperationInput>;

type ItemStatus = "PENDING" | "OK" | "FAILED" | "SKIPPED";
export type PlanItem = { idx: number; chunk: number; from: string; fromLabel: string; to: string; toLabel: string | null; lamports: string; status: ItemStatus; signature?: string | null; reason?: string | null };
type Plan = {
  input: OperationInput;
  kind: "transfer" | "withdraw" | "disperse" | "collect";
  items: PlanItem[];
  chunks: { chunk: number; from: string; fee: string }[];
  errors: string[];
  warnings: string[];
  external: { address: string; newAddress: boolean; offCurve: boolean } | null;
  sources: { address: string; label: string; before: string; after: string }[];
  totalLamports: string;
  feeTotal: string;
  rentExemptMin: string;
};
export type OperationView = Plan & { id: string; status: string; createdAt: number; updatedAt: number };

const sol = (l: bigint) => `${(Number(l) / 1e9).toLocaleString("es-ES", { maximumFractionDigits: 9 })} SOL`;

export class Operations {
  private running = new Set<string>();

  constructor(
    private db: () => DB,
    private chain: ChainManager,
    private vault: Vault,
    private log: (m: string) => void,
  ) {}

  private wallet(id: string) {
    const w = this.db().prepare("SELECT id, label, address, archived FROM wallet WHERE id = ?").get(id) as { id: string; label: string; address: string; archived: number } | undefined;
    if (!w) throw Object.assign(new Error("Wallet no encontrada"), { statusCode: 404 });
    return w;
  }
  private ownByAddress(addr: string) {
    return this.db().prepare("SELECT id, label, address FROM wallet WHERE address = ?").get(addr) as { id: string; label: string; address: string } | undefined;
  }

  /** Construye y valida el plan sin enviar nada. */
  async plan(input: OperationInput): Promise<Plan> {
    const chain = this.chain.get();
    const rentMin = await chain.transfers.rentExemptMin();
    const errors: string[] = [];
    const warnings: string[] = [];
    let external: Plan["external"] = null;
    let kind: Plan["kind"] = input.kind === "transfer" ? "transfer" : input.kind;
    type Raw = { from: { label: string; address: string }; to: string; toLabel: string | null; lamports: bigint | "MAX" };
    const raw: Raw[] = [];

    if (input.kind === "transfer") {
      const from = this.wallet(input.fromId);
      if (!isValidAddress(input.to)) throw Object.assign(new Error("La dirección de destino no es una clave pública válida de Solana."), { statusCode: 400 });
      if (input.to === from.address) throw Object.assign(new Error("El destino es la misma wallet de origen."), { statusCode: 400 });
      const own = this.ownByAddress(input.to);
      if (!own) {
        // El servidor decide: un destino que no es de la bóveda es un retiro (REQ-VAULT-004, REQ-FUND-003)
        kind = "withdraw";
        const known = !!this.db().prepare("SELECT 1 FROM address_book WHERE address = ?").get(input.to);
        external = { address: input.to, newAddress: !known, offCurve: !isOnCurve(input.to) };
        if (!known) warnings.push("Dirección nueva: nunca has enviado fondos a esta dirección.");
        if (external.offCurve) warnings.push("La dirección está fuera de la curva (es un PDA): enviar SOL ahí casi siempre es un error.");
      }
      if (!input.max && !input.lamports) throw Object.assign(new Error("Indica un monto o MAX."), { statusCode: 400 });
      raw.push({ from, to: input.to, toLabel: own?.label ?? null, lamports: input.max ? "MAX" : BigInt(input.lamports!) });
    } else if (input.kind === "disperse") {
      const from = this.wallet(input.fromId);
      const each = BigInt(input.lamportsEach);
      if (each <= 0n) throw Object.assign(new Error("El monto por wallet debe ser mayor que 0."), { statusCode: 400 });
      for (const id of [...new Set(input.toIds)]) {
        const t = this.wallet(id);
        if (t.address === from.address) continue;
        raw.push({ from, to: t.address, toLabel: t.label, lamports: each });
      }
    } else {
      const to = this.wallet(input.toId);
      for (const id of [...new Set(input.fromIds)]) {
        const f = this.wallet(id);
        if (f.address === to.address) continue;
        raw.push({ from: f, to: to.address, toLabel: to.label, lamports: "MAX" });
      }
    }

    const addrs = [...new Set(raw.flatMap((r) => [r.from.address, r.to]))];
    const bal = await chain.reader.balances(addrs);
    const items: PlanItem[] = [];
    const chunks: Plan["chunks"] = [];
    const incoming = new Map<string, bigint>();
    let chunkNo = 0;

    // Agrupa por origen: dispersar es un origen con muchos destinos; recolectar, un origen por tx
    const bySource = new Map<string, Raw[]>();
    for (const r of raw) bySource.set(r.from.address, [...(bySource.get(r.from.address) ?? []), r]);
    const sources: Plan["sources"] = [];

    for (const [src, list] of bySource) {
      const before = bal.get(src) ?? 0n;
      // MAX: el origen acaba exactamente en 0 tras la fee (REQ-COST-002)
      const oneFee = chain.transfers.feeOf((await chain.transfers.build(src, [{ to: list[0].to, lamports: 1n }]))[0]);
      const resolved = list.map((r) => ({ ...r, amount: r.lamports === "MAX" ? before - oneFee : r.lamports }));
      const valid: typeof resolved = [];
      for (const r of resolved) {
        const base = { idx: items.length, chunk: -1, from: src, fromLabel: r.from.label, to: r.to, toLabel: r.toLabel, lamports: (r.amount > 0n ? r.amount : 0n).toString() };
        if (r.amount <= 0n) {
          items.push({ ...base, status: "SKIPPED", reason: "Sin saldo suficiente para cubrir la fee de red." });
          continue;
        }
        const destBefore = (bal.get(r.to) ?? 0n) + (incoming.get(r.to) ?? 0n);
        if (destBefore === 0n && r.amount < rentMin) {
          items.push({ ...base, status: "SKIPPED", reason: `Un destino vacío necesita al menos ${sol(rentMin)} (mínimo exento de rent).` });
          continue;
        }
        incoming.set(r.to, (incoming.get(r.to) ?? 0n) + r.amount);
        valid.push(r);
        items.push({ ...base, status: "PENDING" });
      }
      let fees = 0n;
      if (valid.length) {
        const txs = await chain.transfers.build(src, valid.map((v) => ({ to: v.to, lamports: v.amount })));
        let k = 0;
        for (const tx of txs) {
          const n = (tx.payload as { items?: unknown[]; instructions?: unknown[] }).items?.length ?? (tx.payload as { instructions: unknown[] }).instructions.length;
          const fee = chain.transfers.feeOf(tx);
          fees += fee;
          chunks.push({ chunk: chunkNo, from: src, fee: fee.toString() });
          for (let j = 0; j < n; j++) {
            const it = items.find((x) => x.from === src && x.status === "PENDING" && x.chunk === -1)!;
            it.chunk = chunkNo;
            k++;
          }
          chunkNo++;
        }
        void k;
      }
      const out = valid.reduce((a, v) => a + v.amount, 0n);
      const after = before - out - fees;
      const label = list[0].from.label;
      if (after < 0n) errors.push(`${label}: saldo insuficiente, faltan ${sol(-after)} para montos y fees.`);
      else if (after > 0n && after < rentMin) errors.push(`${label}: quedaría con ${sol(after)}, por debajo del mínimo exento de rent (${sol(rentMin)}). Usa MAX o deja al menos ese mínimo.`);
      sources.push({ address: src, label, before: before.toString(), after: (after > 0n ? after : 0n).toString() });
    }

    if (!items.some((i) => i.status === "PENDING")) errors.push("No hay ninguna transferencia válida en el plan.");
    const total = items.filter((i) => i.status === "PENDING").reduce((a, i) => a + BigInt(i.lamports), 0n);
    const feeTotal = chunks.reduce((a, c) => a + BigInt(c.fee), 0n);
    return { input, kind, items, chunks, errors, warnings, external, sources, totalLamports: total.toString(), feeTotal: feeTotal.toString(), rentExemptMin: rentMin.toString() };
  }

  async preview(input: OperationInput): Promise<OperationView> {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const plan = await this.plan(input);
    const id = randomUUID();
    const now = Date.now();
    this.db().prepare("INSERT INTO operation(id, kind, status, plan, fee_total, created_at, updated_at) VALUES(?, ?, 'PREVIEW', ?, ?, ?, ?)").run(id, plan.kind, JSON.stringify(plan), Number(plan.feeTotal), now, now);
    return this.get(id);
  }

  get(id: string): OperationView {
    const r = this.db().prepare("SELECT * FROM operation WHERE id = ?").get(id) as { id: string; status: string; plan: string; created_at: number; updated_at: number } | undefined;
    if (!r) throw Object.assign(new Error("Operación no encontrada"), { statusCode: 404 });
    const plan = JSON.parse(r.plan) as Plan;
    if (r.status !== "PREVIEW") {
      const rows = this.db().prepare("SELECT idx, status, signature, reason FROM operation_item WHERE op_id = ?").all(id) as { idx: number; status: ItemStatus; signature: string | null; reason: string | null }[];
      for (const row of rows) Object.assign(plan.items[row.idx], { status: row.status, signature: row.signature, reason: row.reason });
    }
    return { ...plan, id: r.id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  list(limit = 20) {
    const ids = this.db().prepare("SELECT id FROM operation WHERE status != 'PREVIEW' ORDER BY created_at DESC LIMIT ?").all(limit) as { id: string }[];
    return ids.map((r) => this.get(r.id));
  }

  /** Ejecuta el plan guardado. Llamar dos veces con el mismo id no duplica nada. */
  async execute(id: string, stepUp: string | undefined): Promise<OperationView> {
    const op = this.get(id);
    if (op.status !== "PREVIEW") return op;
    if (op.errors.length) throw Object.assign(new Error(op.errors.join(" ")), { statusCode: 400 });
    if (op.kind === "withdraw") this.vault.consumeStepUp(stepUp, "withdraw");
    else if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    // REQ-COST-001: recalcular; si el coste o los montos cambian de forma significativa, se vuelve a confirmar
    const fresh = await this.plan(op.input);
    const feeMoved = Math.abs(Number(BigInt(fresh.feeTotal) - BigInt(op.feeTotal))) > Number(BigInt(op.feeTotal)) / 100;
    const amountsMoved = fresh.totalLamports !== op.totalLamports || fresh.errors.length > 0 || fresh.items.length !== op.items.length;
    if (feeMoved || amountsMoved) {
      this.db().prepare("UPDATE operation SET plan = ?, fee_total = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(fresh), Number(fresh.feeTotal), Date.now(), id);
      throw Object.assign(new Error("El coste o los saldos han cambiado desde la vista previa. Revisa y vuelve a confirmar."), { statusCode: 409, code: "PREVIEW_CHANGED" });
    }
    const db = this.db();
    db.transaction(() => {
      const ins = db.prepare("INSERT INTO operation_item(op_id, idx, chunk, from_addr, to_addr, lamports, status, reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?)");
      for (const it of op.items) ins.run(id, it.idx, it.chunk, it.from, it.to, Number(it.lamports), it.status, it.reason ?? null);
      db.prepare("UPDATE operation SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(Date.now(), id);
    })();
    logActivity(db, `funds.${op.kind}`, `${op.kind === "withdraw" ? "Retiro" : op.kind === "disperse" ? "Dispersión" : op.kind === "collect" ? "Recolección" : "Transferencia"} iniciada: ${sol(BigInt(op.totalLamports))} en ${op.items.filter((i) => i.status === "PENDING").length} transferencias${op.external ? ` a ${op.external.address}` : ""}`);
    void this.run(id);
    return this.get(id);
  }

  async resume(id: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const op = this.get(id);
    if (op.status !== "PAUSED") return op;
    this.db().prepare("UPDATE operation SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(Date.now(), id);
    void this.run(id);
    return this.get(id);
  }

  /** Espera a que termine (para tests y para la vista que ya no sondea). */
  async waitIdle(id: string, timeoutMs = 60_000) {
    const t = Date.now();
    while (this.running.has(id) && Date.now() - t < timeoutMs) await new Promise((r) => setTimeout(r, 50));
    return this.get(id);
  }

  private async run(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const chain = this.chain.get();
      const op = this.get(id);
      const byChunk = new Map<number, PlanItem[]>();
      for (const it of op.items) if (it.chunk >= 0) byChunk.set(it.chunk, [...(byChunk.get(it.chunk) ?? []), it]);
      const setItems = this.db().prepare("UPDATE operation_item SET status = ?, signature = ?, reason = ? WHERE op_id = ? AND chunk = ? AND status = 'PENDING'");
      for (const [chunk, items] of [...byChunk].sort((a, b) => a[0] - b[0])) {
        const st = (this.db().prepare("SELECT status FROM operation WHERE id = ?").get(id) as { status: string }).status;
        if (st !== "RUNNING") return; // pausada por un bloqueo
        if (items.every((i) => i.status !== "PENDING")) continue;
        const [tx] = await chain.transfers.build(items[0].from, items.map((i) => ({ to: i.to, lamports: BigInt(i.lamports) })));
        let res;
        try {
          res = await chain.sender.send(tx as PreparedTx, { idempotencyKey: `op:${id}:${chunk}` });
        } catch (e) {
          if (e instanceof VaultError && e.code === "LOCKED") return this.pause(id, "Bóveda bloqueada");
          res = { status: "failed" as const, code: "UNKNOWN" as const, message: (e as Error).message };
        }
        if (res.status === "confirmed") setItems.run("OK", res.signature, null, id, chunk);
        else if (res.status === "failed" && res.code === "UNKNOWN" && /pendiente/i.test(res.message)) return this.pause(id, res.message);
        else if (res.status === "failed") setItems.run("FAILED", res.signature ?? null, res.message, id, chunk);
      }
      this.finish(id);
    } catch (e) {
      this.log(`Operación ${id} interrumpida: ${(e as Error).message}`);
      this.pause(id, (e as Error).message);
    } finally {
      this.running.delete(id);
    }
  }

  private finish(id: string) {
    const rows = this.db().prepare("SELECT status FROM operation_item WHERE op_id = ?").all(id) as { status: ItemStatus }[];
    const ok = rows.filter((r) => r.status === "OK").length;
    const failed = rows.filter((r) => r.status === "FAILED").length;
    const status = failed === 0 ? "COMPLETED" : ok === 0 ? "FAILED" : "PARTIAL";
    this.db().prepare("UPDATE operation SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
    const op = this.get(id);
    if (op.kind === "withdraw" && ok > 0 && op.external && op.external.newAddress) {
      this.db().prepare("INSERT OR IGNORE INTO address_book(address, label, created_at) VALUES(?, ?, ?)").run(op.external.address, `Externa ${op.external.address.slice(0, 4)}…${op.external.address.slice(-4)}`, Date.now());
    }
    logActivity(this.db(), `funds.${op.kind}.done`, `Operación ${status === "COMPLETED" ? "completada" : status === "PARTIAL" ? "parcial" : "fallida"}: ${ok} OK, ${failed} fallidas`);
  }

  private pause(id: string, reason: string) {
    const r = this.db().prepare("UPDATE operation SET status = 'PAUSED', updated_at = ? WHERE id = ? AND status = 'RUNNING'").run(Date.now(), id);
    if (r.changes) this.addPaused(id, reason);
  }

  private addPaused(id: string, _reason: string) {
    const op = this.get(id);
    const label = `${op.kind === "disperse" ? "Dispersión" : op.kind === "collect" ? "Recolección" : op.kind === "withdraw" ? "Retiro" : "Transferencia"} · ${sol(BigInt(op.totalLamports))}`;
    const list = JSON.parse(kvGet(this.db(), "paused") ?? "[]") as { id: string; kind: string; label: string }[];
    if (!list.some((p) => p.id === id)) kvSet(this.db(), "paused", JSON.stringify([...list, { id, kind: "operación", label }]));
  }

  /** Al bloquear la bóveda o al arrancar: lo RUNNING pasa a PAUSED (REQ-VAULT-003, REQ-AUTO-008). */
  pauseAllRunning() {
    const ids = this.db().prepare("SELECT id FROM operation WHERE status = 'RUNNING'").all() as { id: string }[];
    for (const { id } of ids) this.pause(id, "Bóveda bloqueada");
    return ids.length;
  }
}
