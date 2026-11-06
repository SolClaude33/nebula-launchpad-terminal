// REQ-REW-001/002: comisiones de creador reclamables en Pump.fun y PumpSwap.
// La bóveda de comisiones es POR CREADOR (wallet), no por token: la lista es por wallet y se muestran
// como contexto los tokens que esa wallet lanzó desde Nébula. Nunca se inventa un reparto por token.
// Flujo: escanear → vista previa (neto tras la fee de red) → confirmar → enviar → verificar en cadena
// (lo recibido = reclamable − fee y lo reclamable queda en 0).
import { randomUUID } from "node:crypto";
import type { DB } from "./db";
import { kvGet, kvSet, logActivity } from "./db";
import type { Vault } from "./signer";
import { VaultError } from "./signer";
import type { ChainManager } from "./chain-manager";
import { txFee } from "./chain/fees";

type ItemStatus = "PENDING" | "OK" | "FAILED" | "SKIPPED";
const CU_LIMIT = 400_000;

export class Rewards {
  private running = new Set<string>();

  constructor(
    private db: () => DB,
    private chain: ChainManager,
    private vault: Vault,
    private priority: () => number,
    private log: (m: string) => void,
  ) {}

  private fee() {
    return txFee(1, CU_LIMIT, this.priority());
  }

  private launchedBy(address: string) {
    const rows = this.db().prepare("SELECT l.config, l.mint FROM launch l JOIN wallet w ON w.id = json_extract(l.config, '$.devWalletId') WHERE w.address = ? AND l.status = 'DONE'").all(address) as { config: string; mint: string }[];
    return rows.map((r) => ({ mint: r.mint, symbol: (JSON.parse(r.config) as { symbol: string }).symbol }));
  }

  /** Escanea todas las wallets propias activas. */
  async scan() {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const chain = this.chain.get();
    const wallets = this.db().prepare("SELECT id, label, address, role FROM wallet WHERE archived = 0").all() as { id: string; label: string; address: string; role: string | null }[];
    const [fees, sol, usd] = await Promise.all([chain.adapter.claimableFees(wallets.map((w) => w.address)), chain.reader.balances(wallets.map((w) => w.address)), chain.reader.solUsd().catch(() => null)]);
    const fee = this.fee();
    const items = wallets
      .map((w) => {
        const amount = fees.get(w.address) ?? 0n;
        const bal = sol.get(w.address) ?? 0n;
        return { walletId: w.id, label: w.label, address: w.address, role: w.role, claimable: amount.toString(), fee: fee.toString(), net: (amount - fee).toString(), lamports: bal.toString(), canPayFee: bal >= fee, tokens: this.launchedBy(w.address) };
      })
      .filter((i) => BigInt(i.claimable) > 0n || i.tokens.length > 0);
    return { items, solUsd: usd, at: Date.now() };
  }

  /** Vista previa guardada: lo que se reclamará y el neto por wallet tras la fee de red (REQ-REW-002). */
  async preview(walletIds: string[]) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const chain = this.chain.get();
    const get = this.db().prepare("SELECT id, label, address FROM wallet WHERE id = ? AND archived = 0");
    const wallets = [...new Set(walletIds)].map((id) => {
      const w = get.get(id) as { id: string; label: string; address: string } | undefined;
      if (!w) throw Object.assign(new Error("Una wallet no existe o está archivada."), { statusCode: 400 });
      return w;
    });
    const [fees, sol] = await Promise.all([chain.adapter.claimableFees(wallets.map((w) => w.address)), chain.reader.balances(wallets.map((w) => w.address))]);
    const fee = this.fee();
    const id = randomUUID();
    // REQ-COST-001: el neto sale de simular el reclamo y leer el saldo posterior de la wallet. Así incluye
    // la fee de red y el rent de las cuentas que crea (p. ej. la WSOL del vault de PumpSwap la primera vez).
    const rows: { w: (typeof wallets)[number]; expected: bigint; cost: bigint; skip: string | null }[] = [];
    for (const w of wallets) {
      const amount = fees.get(w.address) ?? 0n;
      const bal = sol.get(w.address) ?? 0n;
      // REQ-REW-003 (S) queda fuera: sin SOL para la fee, la wallet se omite con el motivo
      let skip = amount === 0n ? "No hay comisiones que reclamar." : bal < fee ? "Sin SOL para la fee de red: recarga la wallet antes de reclamar." : null;
      let cost = fee;
      if (!skip) {
        const sim = await chain.sender.send(await chain.adapter.buildClaimTx({ creator: w.address }), { idempotencyKey: `claim-preview:${id}:${w.id}`, simulateOnly: true, watch: w.address });
        if (sim.status === "simulated" && sim.postLamports !== undefined) {
          cost = bal + amount - sim.postLamports;
          if (cost < fee) cost = fee;
          if (amount <= cost) skip = "No compensa: el coste del reclamo supera lo reclamable.";
        } else skip = `La simulación del reclamo falló: ${"message" in sim ? sim.message : sim.status}`;
      }
      rows.push({ w, expected: amount, cost, skip });
    }
    const now = Date.now();
    const db = this.db();
    db.transaction(() => {
      db.prepare("INSERT INTO claim(id, status, created_at, updated_at) VALUES(?, 'PREVIEW', ?, ?)").run(id, now, now);
      const ins = db.prepare("INSERT INTO claim_item(claim_id, ord, wallet_id, address, expected, fee, network_fee, status, reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)");
      rows.forEach((r, i) => ins.run(id, i, r.w.id, r.w.address, r.expected.toString(), r.cost.toString(), fee.toString(), r.skip ? "SKIPPED" : "PENDING", r.skip));
    })();
    return this.view(id);
  }

  view(id: string) {
    const c = this.db().prepare("SELECT * FROM claim WHERE id = ?").get(id) as { id: string; status: string; created_at: number; updated_at: number } | undefined;
    if (!c) throw Object.assign(new Error("Reclamo no encontrado"), { statusCode: 404 });
    const items = this.db()
      .prepare("SELECT i.ord, i.wallet_id AS walletId, w.label, i.address, i.expected, i.fee, i.network_fee AS networkFee, i.status, i.received, i.left_after AS leftAfter, i.signature, i.reason FROM claim_item i LEFT JOIN wallet w ON w.id = i.wallet_id WHERE i.claim_id = ? ORDER BY i.ord")
      .all(id) as { ord: number; walletId: string; label: string; address: string; expected: string; fee: string; networkFee: string; status: ItemStatus; received: string | null; leftAfter: string | null; signature: string | null; reason: string | null }[];
    const pending = items.filter((i) => i.status !== "SKIPPED");
    const gross = pending.reduce((a, i) => a + BigInt(i.expected), 0n);
    const fees = pending.reduce((a, i) => a + BigInt(i.fee), 0n);
    return { id: c.id, status: c.status, items, totals: { gross: gross.toString(), fees: fees.toString(), net: (gross - fees).toString() }, createdAt: c.created_at, updatedAt: c.updated_at };
  }

  /** Ejecuta la vista previa confirmada. Si lo reclamable bajó, se vuelve a confirmar. */
  async execute(id: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const v = this.view(id);
    if (v.status !== "PREVIEW") return v;
    const chain = this.chain.get();
    const items = v.items;
    const todo = items.filter((i) => i.status === "PENDING");
    if (todo.length === 0) throw Object.assign(new Error("No hay nada que reclamar en esta selección."), { statusCode: 400 });
    const now = await chain.adapter.claimableFees(todo.map((i) => i.address));
    const dropped = todo.filter((i) => (now.get(i.address) ?? 0n) * 100n < BigInt(i.expected) * 99n);
    if (dropped.length) {
      for (const i of todo) this.db().prepare("UPDATE claim_item SET expected = ? WHERE claim_id = ? AND ord = ?").run((now.get(i.address) ?? 0n).toString(), id, i.ord);
      throw Object.assign(new Error("Lo reclamable ha cambiado desde la vista previa. Revisa y vuelve a confirmar."), { statusCode: 409, code: "PREVIEW_CHANGED" });
    }
    this.db().prepare("UPDATE claim SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(Date.now(), id);
    logActivity(this.db(), "rewards.claim", `Reclamo de comisiones iniciado en ${todo.length} wallets (≈ ${(Number(v.totals.net) / 1e9).toFixed(4)} SOL netos)`);
    void this.run(id);
    return this.view(id);
  }

  async resume(id: string) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const v = this.view(id);
    if (v.status !== "PAUSED") return v;
    this.db().prepare("UPDATE claim SET status = 'RUNNING', updated_at = ? WHERE id = ?").run(Date.now(), id);
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
      const items = this.db().prepare("SELECT ord, address, expected FROM claim_item WHERE claim_id = ? AND status = 'PENDING' ORDER BY ord").all(id) as { ord: number; address: string; expected: string }[];
      const upd = this.db().prepare("UPDATE claim_item SET status = ?, received = ?, left_after = ?, signature = ?, reason = ? WHERE claim_id = ? AND ord = ?");
      for (const it of items) {
        if ((this.db().prepare("SELECT status FROM claim WHERE id = ?").get(id) as { status: string }).status !== "RUNNING") return;
        const key = `claim:${id}:${it.ord}`;
        const sentBefore = !!this.db().prepare("SELECT 1 FROM tx WHERE idempotency_key = ?").get(key);
        const before = (await chain.reader.balances([it.address])).get(it.address) ?? 0n;
        let res;
        try {
          res = await chain.sender.send(await chain.adapter.buildClaimTx({ creator: it.address }), { idempotencyKey: key });
        } catch (e) {
          if (e instanceof VaultError && e.code === "LOCKED") return this.pause(id);
          if (e instanceof VaultError && e.code === "NO_KEY") {
            upd.run("FAILED", null, null, null, e.message, id, it.ord);
            continue;
          }
          return this.pause(id);
        }
        if (res.status === "pending") return this.pause(id); // pudo aterrizar: nunca se marca como fallido
        if (res.status === "failed") {
          if (res.code === "UNKNOWN") return this.pause(id);
          upd.run("FAILED", null, null, res.signature ?? null, res.message, id, it.ord);
          continue;
        }
        if (res.status !== "confirmed") continue;
        // Verificación en cadena: saldo recibido y bóveda vacía
        const [after, left] = await Promise.all([chain.reader.balances([it.address]), chain.adapter.claimableFees([it.address])]);
        const received = (after.get(it.address) ?? 0n) - before;
        upd.run("OK", sentBefore || res.reused ? null : received.toString(), (left.get(it.address) ?? 0n).toString(), res.signature, null, id, it.ord);
      }
      const rows = this.db().prepare("SELECT status FROM claim_item WHERE claim_id = ? AND status != 'SKIPPED'").all(id) as { status: ItemStatus }[];
      const ok = rows.filter((r) => r.status === "OK").length;
      const status = ok === rows.length ? "COMPLETED" : ok === 0 ? "FAILED" : "PARTIAL";
      this.db().prepare("UPDATE claim SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
      logActivity(this.db(), "rewards.claim.done", `Reclamo de comisiones: ${ok}/${rows.length} wallets cobradas`);
    } catch (e) {
      this.log(`Reclamo ${id} interrumpido: ${(e as Error).message}`);
      this.pause(id);
    } finally {
      this.running.delete(id);
    }
  }

  private pause(id: string) {
    const r = this.db().prepare("UPDATE claim SET status = 'PAUSED', updated_at = ? WHERE id = ? AND status = 'RUNNING'").run(Date.now(), id);
    if (!r.changes) return;
    const list = JSON.parse(kvGet(this.db(), "paused") ?? "[]") as { id: string; kind: string; label: string }[];
    if (!list.some((p) => p.id === id)) kvSet(this.db(), "paused", JSON.stringify([...list, { id, kind: "reclamo", label: "Reclamo de comisiones" }]));
  }

  pauseAllRunning() {
    const ids = this.db().prepare("SELECT id FROM claim WHERE status = 'RUNNING'").all() as { id: string }[];
    for (const { id } of ids) this.pause(id);
    return ids.length;
  }
}
