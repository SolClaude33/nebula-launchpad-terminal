// REQ-REW-001/002: comisiones de creador reclamables en Pump.fun y PumpSwap.
// La bóveda de comisiones es POR CREADOR (wallet), no por token: la lista es por wallet y se muestran
// como contexto los tokens que esa wallet lanzó desde Nébula. Nunca se inventa un reparto por token.
// Flujo: escanear → vista previa (neto tras la fee de red) → confirmar → enviar → verificar en cadena
// (lo recibido = reclamable − fee y lo reclamable queda en 0).
// REQ-REW-003 (opcional, `fund`): a la wallet sin SOL para el reclamo se le transfiere antes, desde el funder
// predeterminado, lo justo (fee + rent que adelanta + mínimo exento si está vacía). Esa recarga se queda en la
// wallet propia: el coste extra es solo la fee de la transferencia (más el rent de cuentas nuevas, como siempre).
// Sin saldo no se puede simular, así que el neto de esas wallets es una estimación; lo recibido se sigue
// verificando en cadena DESPUÉS de la recarga.
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

  private defaultFunder() {
    return this.db().prepare("SELECT id, label, address FROM wallet WHERE kind = 'funder' AND is_default_funder = 1 AND archived = 0").get() as { id: string; label: string; address: string } | undefined;
  }

  /** Escanea todas las wallets propias activas. */
  async scan() {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const chain = this.chain.get();
    const wallets = this.db().prepare("SELECT id, label, address, role FROM wallet WHERE archived = 0").all() as { id: string; label: string; address: string; role: string | null }[];
    const funder = this.defaultFunder();
    const addrs = [...new Set([...wallets.map((w) => w.address), ...(funder ? [funder.address] : [])])];
    const [fees, sol, usd] = await Promise.all([chain.adapter.claimableFees(wallets.map((w) => w.address)), chain.reader.balances(addrs), chain.reader.solUsd().catch(() => null)]);
    const fee = this.fee();
    const items = wallets
      .map((w) => {
        const amount = fees.get(w.address) ?? 0n;
        const bal = sol.get(w.address) ?? 0n;
        return { walletId: w.id, label: w.label, address: w.address, role: w.role, claimable: amount.toString(), fee: fee.toString(), net: (amount - fee).toString(), lamports: bal.toString(), canPayFee: bal >= fee, tokens: this.launchedBy(w.address) };
      })
      .filter((i) => BigInt(i.claimable) > 0n || i.tokens.length > 0);
    return { items, funder: funder ? { ...funder, lamports: (sol.get(funder.address) ?? 0n).toString() } : null, solUsd: usd, at: Date.now() };
  }

  /** Vista previa guardada: lo que se reclamará y el neto por wallet tras la fee de red (REQ-REW-002). */
  async preview(walletIds: string[], opts: { fund?: boolean } = {}) {
    if (!this.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    const chain = this.chain.get();
    const get = this.db().prepare("SELECT id, label, address FROM wallet WHERE id = ? AND archived = 0");
    const wallets = [...new Set(walletIds)].map((id) => {
      const w = get.get(id) as { id: string; label: string; address: string } | undefined;
      if (!w) throw Object.assign(new Error("Una wallet no existe o está archivada."), { statusCode: 400 });
      return w;
    });
    const funder = opts.fund ? this.defaultFunder() : undefined;
    if (opts.fund && !funder) throw Object.assign(new Error("No hay un funder predeterminado del que recargar."), { statusCode: 400 });
    const addrs = [...new Set([...wallets.map((w) => w.address), ...(funder ? [funder.address] : [])])];
    const [fees, sol] = await Promise.all([chain.adapter.claimableFees(wallets.map((w) => w.address)), chain.reader.balances(addrs)]);
    const fee = this.fee();
    const rentMin = funder ? await chain.transfers.rentExemptMin() : 0n;
    const topupFee = funder ? chain.transfers.feeOf((await chain.transfers.build(funder.address, [{ to: wallets[0].address, lamports: 1n }]))[0]) : 0n;
    const id = randomUUID();
    // REQ-COST-001: el neto sale de simular el reclamo y leer el saldo posterior de la wallet. Así incluye
    // la fee de red y el rent de las cuentas que crea (p. ej. la WSOL del vault de PumpSwap la primera vez).
    type Row = { w: (typeof wallets)[number]; expected: bigint; cost: bigint; skip: string | null; topup: bigint | null };
    const rows: Row[] = [];
    for (const w of wallets) {
      const amount = fees.get(w.address) ?? 0n;
      const bal = sol.get(w.address) ?? 0n;
      if (amount === 0n) {
        rows.push({ w, expected: 0n, cost: fee, skip: "No hay comisiones que reclamar.", topup: null });
        continue;
      }
      const rent = await chain.adapter.claimRent(w.address);
      const need = fee + rent.upfront;
      if (funder && bal < need && w.address !== funder.address) {
        // REQ-REW-003: recarga justa; un destino vacío tiene que quedar por encima del mínimo exento de rent
        const topup = (need > rentMin ? need : rentMin) - bal;
        // el rent que no vuelve (WSOL del vault de PumpSwap) es coste, como las «cuentas nuevas» de la ruta simulada
        const cost = fee + rent.kept + topupFee;
        rows.push({ w, expected: amount, cost, topup, skip: amount <= cost ? "No compensa: el coste del reclamo supera lo reclamable." : null });
        continue;
      }
      let skip = bal < fee ? "Sin SOL para la fee de red: activa «Recargar desde el funder» o recarga la wallet." : null;
      let cost = fee;
      if (!skip) {
        const sim = await chain.sender.send(await chain.adapter.buildClaimTx({ creator: w.address }), { idempotencyKey: `claim-preview:${id}:${w.id}`, simulateOnly: true, watch: w.address });
        if (sim.status === "simulated" && sim.postLamports !== undefined) {
          cost = bal + amount - sim.postLamports;
          if (cost < fee) cost = fee;
          if (amount <= cost) skip = "No compensa: el coste del reclamo supera lo reclamable.";
        } else skip = `La simulación del reclamo falló: ${"message" in sim ? sim.message : sim.status}`;
      }
      rows.push({ w, expected: amount, cost, skip, topup: null });
    }
    if (funder) {
      // El funder paga recargas y sus fees, y tiene que acabar en 0 o por encima del mínimo exento (como en operations)
      const funded = rows.filter((r) => r.topup !== null && !r.skip);
      const spend = funded.reduce((a, r) => a + r.topup! + topupFee, 0n);
      const left = (sol.get(funder.address) ?? 0n) - spend;
      if (funded.length && (left < 0n || (left > 0n && left < rentMin))) {
        const short = left < 0n ? -left : rentMin - left;
        for (const r of funded) r.skip = `${funder.label} no tiene SOL suficiente para las recargas (faltan ${(Number(short) / 1e9).toFixed(6)} SOL).`;
      }
    }
    const now = Date.now();
    const db = this.db();
    db.transaction(() => {
      db.prepare("INSERT INTO claim(id, status, funder_id, created_at, updated_at) VALUES(?, 'PREVIEW', ?, ?, ?)").run(id, funder?.id ?? null, now, now);
      const ins = db.prepare("INSERT INTO claim_item(claim_id, ord, wallet_id, address, expected, fee, network_fee, topup, topup_fee, status, reason) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      rows.forEach((r, i) => ins.run(id, i, r.w.id, r.w.address, r.expected.toString(), r.cost.toString(), fee.toString(), r.topup?.toString() ?? null, r.topup !== null ? topupFee.toString() : null, r.skip ? "SKIPPED" : "PENDING", r.skip));
    })();
    return this.view(id);
  }

  view(id: string) {
    const c = this.db().prepare("SELECT c.*, w.label AS funder_label, w.address AS funder_address FROM claim c LEFT JOIN wallet w ON w.id = c.funder_id WHERE c.id = ?").get(id) as { id: string; status: string; funder_id: string | null; funder_label: string | null; funder_address: string | null; created_at: number; updated_at: number } | undefined;
    if (!c) throw Object.assign(new Error("Reclamo no encontrado"), { statusCode: 404 });
    const items = this.db()
      .prepare("SELECT i.ord, i.wallet_id AS walletId, w.label, i.address, i.expected, i.fee, i.network_fee AS networkFee, i.topup, i.topup_fee AS topupFee, i.topup_signature AS topupSignature, i.status, i.received, i.left_after AS leftAfter, i.signature, i.reason FROM claim_item i LEFT JOIN wallet w ON w.id = i.wallet_id WHERE i.claim_id = ? ORDER BY i.ord")
      .all(id) as { ord: number; walletId: string; label: string; address: string; expected: string; fee: string; networkFee: string; topup: string | null; topupFee: string | null; topupSignature: string | null; status: ItemStatus; received: string | null; leftAfter: string | null; signature: string | null; reason: string | null }[];
    const pending = items.filter((i) => i.status !== "SKIPPED");
    const gross = pending.reduce((a, i) => a + BigInt(i.expected), 0n);
    // `fee` ya incluye la fee de la recarga; el monto recargado no es un coste (se queda en la wallet)
    const fees = pending.reduce((a, i) => a + BigInt(i.fee), 0n);
    const topup = pending.reduce((a, i) => a + BigInt(i.topup ?? "0"), 0n);
    const funder = c.funder_id ? { id: c.funder_id, label: c.funder_label, address: c.funder_address } : null;
    return { id: c.id, status: c.status, funder, items, totals: { gross: gross.toString(), fees: fees.toString(), net: (gross - fees).toString(), topup: topup.toString() }, createdAt: c.created_at, updatedAt: c.updated_at };
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
    // REQ-REW-003: el funder tiene que seguir cubriendo las recargas; si no, se vuelve a confirmar antes de enviar nada
    const funded = todo.filter((i) => i.topup !== null);
    if (funded.length && v.funder?.address) {
      const spend = funded.reduce((a, i) => a + BigInt(i.topup!) + BigInt(i.topupFee ?? "0"), 0n);
      const rentMin = await chain.transfers.rentExemptMin();
      const left = ((await chain.reader.balances([v.funder.address])).get(v.funder.address) ?? 0n) - spend;
      if (left < 0n || (left > 0n && left < rentMin)) throw Object.assign(new Error(`${v.funder.label} ya no tiene SOL suficiente para las recargas. Prepara el reclamo de nuevo.`), { statusCode: 409, code: "PREVIEW_CHANGED" });
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
      const items = this.db().prepare("SELECT ord, address, expected, network_fee AS networkFee, topup, topup_signature AS topupSignature FROM claim_item WHERE claim_id = ? AND status = 'PENDING' ORDER BY ord").all(id) as { ord: number; address: string; expected: string; networkFee: string; topup: string | null; topupSignature: string | null }[];
      const upd = this.db().prepare("UPDATE claim_item SET status = ?, received = ?, left_after = ?, signature = ?, reason = ? WHERE claim_id = ? AND ord = ?");
      const funder = this.view(id).funder;
      for (const it of items) {
        if ((this.db().prepare("SELECT status FROM claim WHERE id = ?").get(id) as { status: string }).status !== "RUNNING") return;
        // REQ-REW-003: primero la recarga (su propia idempotency key) y solo cuando está confirmada, el reclamo
        if (it.topup !== null && !it.topupSignature) {
          const fundKey = `claim-fund:${id}:${it.ord}`;
          const sent = !!this.db().prepare("SELECT 1 FROM tx WHERE idempotency_key = ?").get(fundKey);
          const bal = (await chain.reader.balances([it.address])).get(it.address) ?? 0n;
          const need = BigInt(it.networkFee) + (await chain.adapter.claimRent(it.address)).upfront;
          if (sent || bal < need) {
            if (!funder?.address) {
              upd.run("FAILED", null, null, null, "El funder de la recarga ya no existe.", id, it.ord);
              continue;
            }
            const [ftx] = await chain.transfers.build(funder.address, [{ to: it.address, lamports: BigInt(it.topup) }]);
            let fres;
            try {
              fres = await chain.sender.send(ftx, { idempotencyKey: fundKey });
            } catch (e) {
              if (e instanceof VaultError && e.code === "NO_KEY") {
                upd.run("FAILED", null, null, null, `Recarga desde el funder: ${e.message}`, id, it.ord);
                continue;
              }
              return this.pause(id);
            }
            if (fres.status === "pending" || (fres.status === "failed" && fres.code === "UNKNOWN")) return this.pause(id); // pudo aterrizar
            if (fres.status !== "confirmed") {
              upd.run("FAILED", null, null, null, `La recarga desde el funder falló: ${"message" in fres ? fres.message : fres.status}`, id, it.ord);
              continue;
            }
            this.db().prepare("UPDATE claim_item SET topup_signature = ? WHERE claim_id = ? AND ord = ?").run(fres.signature, id, it.ord);
          } else {
            // ya tenía saldo al ejecutar: no se recarga y la fee de la transferencia no se cobra
            this.db().prepare("UPDATE claim_item SET fee = CAST(CAST(fee AS INTEGER) - CAST(topup_fee AS INTEGER) AS TEXT), topup = NULL, topup_fee = NULL WHERE claim_id = ? AND ord = ?").run(id, it.ord);
          }
        }
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
