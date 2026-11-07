// REQ-WAL-010: recuperar rent. Cierra las cuentas de token VACÍAS (saldo exactamente 0, Token y Token-2022)
// de las wallets propias y manda su rent a una wallet propia elegida, que paga la fee (firma también la dueña,
// así una wallet sin SOL puede cerrar sus cuentas). Nunca quema polvo: una cuenta con saldo no se toca.
// Flujo como el resto de fondos: escanear → vista previa simulada (neto por tx) → confirmar → enviar →
// verificar en cadena (lo recibido por el destino y que las cuentas ya no existen).
// Se omiten las wallets con un movimiento, orden, lanzamiento o tarea en curso o en pausa (REQ-WAL-007).
import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import { kvGet, kvSet, logActivity } from "./db";
import type { Vault } from "./signer";
import { VaultError } from "./signer";
import type { ChainManager } from "./chain-manager";
import type { EmptyTokenAccount } from "./chain/types";

/** Cuentas por transacción: ~16 cierres + 2 firmas caben con margen en 1.232 bytes (medido en el test). */
export const CLOSE_CHUNK = 16;
type ItemStatus = "PENDING" | "OK" | "FAILED" | "SKIPPED";
type W = { id: string; label: string; address: string };

export class Reclaim {
  private running = new Set<string>();

  constructor(
    private db: () => DB,
    private chain: ChainManager,
    private vault: Vault,
    private log: (m: string) => void,
  ) {}

  private locked() {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
  }

  /** Wallets con algo en marcha o en pausa: id → motivo. */
  busyWallets() {
    const db = this.db();
    const out = new Map<string, string>();
    const byAddr = db.prepare("SELECT id FROM wallet WHERE address = ?");
    for (const r of db.prepare("SELECT DISTINCT i.from_addr AS a, i.to_addr AS b FROM operation_item i JOIN operation o ON o.id = i.op_id WHERE o.status IN ('RUNNING','PAUSED')").all() as { a: string; b: string }[])
      for (const a of [r.a, r.b]) {
        const w = byAddr.get(a) as { id: string } | undefined;
        if (w) out.set(w.id, "Tiene un movimiento de fondos en curso o en pausa.");
      }
    for (const r of db.prepare("SELECT DISTINCT i.wallet_id AS id FROM trade_order_item i JOIN trade_order o ON o.id = i.order_id WHERE o.status IN ('RUNNING','PAUSED')").all() as { id: string }[]) out.set(r.id, "Tiene una orden en curso o en pausa.");
    for (const r of db.prepare("SELECT config FROM launch WHERE status IN ('CREATING','CREATED','BUYING','PAUSED')").all() as { config: string }[]) {
      const c = JSON.parse(r.config) as { devWalletId: string; holders?: { walletId: string }[] };
      for (const id of [c.devWalletId, ...(c.holders ?? []).map((h) => h.walletId)]) out.set(id, "Forma parte de un lanzamiento en curso o en pausa.");
    }
    for (const r of db.prepare("SELECT config FROM task WHERE status IN ('RUNNING','PAUSED')").all() as { config: string }[]) {
      const c = JSON.parse(r.config) as { walletIds?: string[] };
      for (const id of c.walletIds ?? []) out.set(id, "La usa una automatización en marcha o en pausa.");
    }
    for (const r of db.prepare("SELECT DISTINCT wallet_id AS id FROM claim_item i JOIN claim c ON c.id = i.claim_id WHERE c.status IN ('RUNNING','PAUSED')").all() as { id: string }[]) out.set(r.id, "Tiene un reclamo de comisiones en curso o en pausa.");
    return out;
  }

  private wallets(ids?: string[]) {
    const db = this.db();
    if (!ids) return db.prepare("SELECT id, label, address FROM wallet WHERE archived = 0 ORDER BY kind, created_at, label").all() as W[];
    const get = db.prepare("SELECT id, label, address FROM wallet WHERE id = ? AND archived = 0");
    return [...new Set(ids)].map((id) => {
      const w = get.get(id) as W | undefined;
      if (!w) throw Object.assign(new Error("Una wallet no existe o está archivada."), { statusCode: 400 });
      return w;
    });
  }

  /** Escaneo: cuentas vacías y rent recuperable por wallet (2 lecturas por wallet, por el limitador del RPC). */
  async scan() {
    this.locked();
    const chain = this.chain.get();
    const busy = this.busyWallets();
    const items = [];
    for (const w of this.wallets()) {
      const accounts = await chain.reader.emptyTokenAccounts(w.address);
      items.push({ walletId: w.id, label: w.label, address: w.address, accounts: accounts.length, lamports: accounts.reduce((a, x) => a + x.lamports, 0n).toString(), busy: busy.get(w.id) ?? null });
    }
    return { items: items.filter((i) => i.accounts > 0), total: items.reduce((a, i) => a + BigInt(i.lamports), 0n).toString(), at: Date.now() };
  }

  async preview(walletIds: string[], toId: string) {
    this.locked();
    const chain = this.chain.get();
    const [dest] = this.wallets([toId]);
    const owners = this.wallets(walletIds);
    const busy = this.busyWallets();
    const id = randomUUID();
    type Row = { w: W; accounts: EmptyTokenAccount[]; expected: bigint; fee: bigint; skip: string | null };
    const rows: Row[] = [];
    for (const w of owners) {
      const b = busy.get(w.id);
      const accounts = b ? [] : await chain.reader.emptyTokenAccounts(w.address);
      if (b || accounts.length === 0) {
        rows.push({ w, accounts, expected: 0n, fee: 0n, skip: b ?? "No tiene cuentas de token vacías." });
        continue;
      }
      for (let i = 0; i < accounts.length; i += CLOSE_CHUNK) {
        const chunk = accounts.slice(i, i + CLOSE_CHUNK);
        const rent = chunk.reduce((a, x) => a + x.lamports, 0n);
        const tx = await chain.adapter.buildCloseAccountsTx({ owner: w.address, dest: dest.address, accounts: chunk });
        // REQ-COST-001: el neto sale de simular y leer el saldo posterior del destino (rent − fee)
        const before = (await chain.reader.balances([dest.address])).get(dest.address) ?? 0n;
        const sim = await chain.sender.send(tx, { idempotencyKey: `reclaim-preview:${id}:${w.id}:${i}`, simulateOnly: true, watch: dest.address });
        if (sim.status === "simulated" && sim.postLamports !== undefined) {
          const net = sim.postLamports - before;
          rows.push({ w, accounts: chunk, expected: net, fee: rent - net, skip: net <= 0n ? "No compensa: la fee supera el rent de estas cuentas." : null });
        } else rows.push({ w, accounts: chunk, expected: 0n, fee: 0n, skip: `La simulación falló: ${"message" in sim ? sim.message : sim.status}` });
      }
    }
    const now = Date.now();
    const db = this.db();
    db.transaction(() => {
      db.prepare("INSERT INTO reclaim(id, status, to_wallet_id, created_at, updated_at) VALUES(?, 'PREVIEW', ?, ?, ?)").run(id, dest.id, now, now);
      const ins = db.prepare("INSERT INTO reclaim_item(reclaim_id, ord, wallet_id, owner, accounts, rent, expected, fee, status, reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      rows.forEach((r, i) => {
        const accounts = r.accounts.map((a) => ({ ...a, lamports: a.lamports.toString() }));
        ins.run(id, i, r.w.id, r.w.address, JSON.stringify(accounts), r.accounts.reduce((a, x) => a + x.lamports, 0n).toString(), r.expected.toString(), r.fee.toString(), r.skip ? "SKIPPED" : "PENDING", r.skip);
      });
    })();
    return this.view(id);
  }

  view(id: string) {
    const r = this.db().prepare("SELECT r.*, w.label AS to_label, w.address AS to_address FROM reclaim r LEFT JOIN wallet w ON w.id = r.to_wallet_id WHERE r.id = ?").get(id) as { id: string; status: string; to_wallet_id: string; to_label: string | null; to_address: string | null; created_at: number; updated_at: number } | undefined;
    if (!r) throw Object.assign(new Error("Recuperación no encontrada"), { statusCode: 404 });
    const rows = this.db()
      .prepare("SELECT i.ord, i.wallet_id AS walletId, w.label, i.owner, i.accounts, i.rent, i.expected, i.fee, i.status, i.received, i.signature, i.reason FROM reclaim_item i LEFT JOIN wallet w ON w.id = i.wallet_id WHERE i.reclaim_id = ? ORDER BY i.ord")
      .all(id) as { ord: number; walletId: string; label: string; owner: string; accounts: string; rent: string; expected: string; fee: string; status: ItemStatus; received: string | null; signature: string | null; reason: string | null }[];
    const items = rows.map(({ accounts, ...x }) => ({ ...x, accounts: (JSON.parse(accounts) as unknown[]).length, accountList: JSON.parse(accounts) as { address: string; mint: string; program: string; lamports: string }[] }));
    const pending = items.filter((i) => i.status !== "SKIPPED");
    const sum = (k: "rent" | "expected" | "fee") => pending.reduce((a, i) => a + BigInt(i[k]), 0n).toString();
    return { id: r.id, status: r.status, to: { id: r.to_wallet_id, label: r.to_label, address: r.to_address }, items, totals: { accounts: pending.reduce((a, i) => a + i.accounts, 0), rent: sum("rent"), fees: sum("fee"), net: sum("expected") }, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  async execute(id: string) {
    this.locked();
    const v = this.view(id);
    if (v.status !== "PREVIEW") return v;
    const todo = v.items.filter((i) => i.status === "PENDING");
    if (todo.length === 0) throw Object.assign(new Error("No hay cuentas que cerrar en esta selección."), { statusCode: 400 });
    // Las cuentas tienen que seguir vacías y existir; las wallets, libres
    const chain = this.chain.get();
    const busy = this.busyWallets();
    for (const it of todo) {
      if (busy.has(it.walletId)) throw Object.assign(new Error(`${it.label}: ${busy.get(it.walletId)} Prepara la recuperación de nuevo.`), { statusCode: 409, code: "PREVIEW_CHANGED" });
      const now = new Set((await chain.reader.emptyTokenAccounts(it.owner)).map((a) => a.address));
      if (it.accountList.some((a) => !now.has(a.address))) throw Object.assign(new Error("Alguna cuenta ya no está vacía o ya se cerró. Prepara la recuperación de nuevo."), { statusCode: 409, code: "PREVIEW_CHANGED" });
    }
    this.db().prepare("UPDATE reclaim SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(Date.now(), id);
    logActivity(this.db(), "wallets.reclaim", `Recuperar rent iniciado: ${v.totals.accounts} cuentas (≈ ${(Number(v.totals.net) / 1e9).toFixed(4)} SOL netos a ${v.to.label})`);
    void this.run(id);
    return this.view(id);
  }

  async resume(id: string) {
    this.locked();
    const v = this.view(id);
    if (v.status !== "PAUSED") return v;
    this.db().prepare("UPDATE reclaim SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(Date.now(), id);
    void this.run(id);
    return this.view(id);
  }

  async waitIdle(id: string, timeoutMs = 120_000) {
    const t = Date.now();
    while (this.running.has(id) && Date.now() - t < timeoutMs) await new Promise((r) => setTimeout(r, 50));
    return this.view(id);
  }

  private async run(id: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const chain = this.chain.get();
      const v = this.view(id);
      const dest = v.to.address!;
      const upd = this.db().prepare("UPDATE reclaim_item SET status = ?, received = ?, signature = ?, reason = ? WHERE reclaim_id = ? AND ord = ?");
      for (const it of v.items.filter((i) => i.status === "PENDING")) {
        if ((this.db().prepare("SELECT status FROM reclaim WHERE id = ?").get(id) as { status: string }).status !== "RUNNING") return;
        const key = `reclaim:${id}:${it.ord}`;
        const sentBefore = !!this.db().prepare("SELECT 1 FROM tx WHERE idempotency_key = ?").get(key);
        const before = (await chain.reader.balances([dest])).get(dest) ?? 0n;
        const accounts = it.accountList.map((a) => ({ ...a, lamports: BigInt(a.lamports) }));
        let res;
        try {
          res = await chain.sender.send(await chain.adapter.buildCloseAccountsTx({ owner: it.owner, dest, accounts }), { idempotencyKey: key });
        } catch (e) {
          if (e instanceof VaultError && e.code === "NO_KEY") {
            upd.run("FAILED", null, null, e.message, id, it.ord);
            continue;
          }
          return this.pause(id);
        }
        if (res.status === "pending" || (res.status === "failed" && res.code === "UNKNOWN")) return this.pause(id); // pudo aterrizar
        if (res.status !== "confirmed") {
          upd.run("FAILED", null, "signature" in res ? (res.signature ?? null) : null, "message" in res ? res.message : res.status, id, it.ord);
          continue;
        }
        // Verificación en cadena: lo recibido por el destino y que las cuentas ya no existen
        const after = (await chain.reader.balances([dest])).get(dest) ?? 0n;
        const left = (await Promise.all(accounts.map((a) => chain.reader.accountExists(a.address)))).filter(Boolean).length;
        upd.run(left ? "FAILED" : "OK", sentBefore || res.reused ? null : (after - before).toString(), res.signature, left ? `Quedan ${left} cuentas sin cerrar.` : null, id, it.ord);
      }
      const rows = this.db().prepare("SELECT status FROM reclaim_item WHERE reclaim_id = ? AND status != 'SKIPPED'").all(id) as { status: ItemStatus }[];
      const ok = rows.filter((r) => r.status === "OK").length;
      const status = ok === rows.length ? "COMPLETED" : ok === 0 ? "FAILED" : "PARTIAL";
      this.db().prepare("UPDATE reclaim SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
      logActivity(this.db(), "wallets.reclaim.done", `Recuperar rent: ${ok}/${rows.length} transacciones OK`);
    } catch (e) {
      this.log(`Recuperación ${id} interrumpida: ${(e as Error).message}`);
      this.pause(id);
    } finally {
      this.running.delete(id);
    }
  }

  private pause(id: string) {
    const r = this.db().prepare("UPDATE reclaim SET status = 'PAUSED', updated_at = ? WHERE id = ? AND status = 'RUNNING'").run(Date.now(), id);
    if (!r.changes) return;
    const list = JSON.parse(kvGet(this.db(), "paused") ?? "[]") as { id: string; kind: string; label: string }[];
    if (!list.some((p) => p.id === id)) kvSet(this.db(), "paused", JSON.stringify([...list, { id, kind: "rent", label: "Recuperar rent" }]));
  }

  pauseAllRunning() {
    const ids = this.db().prepare("SELECT id FROM reclaim WHERE status = 'RUNNING'").all() as { id: string }[];
    for (const { id } of ids) this.pause(id);
    return ids.length;
  }
}
