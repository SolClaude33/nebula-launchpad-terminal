// tx-sender (§5.3): compila v0, firma con la bóveda, simula, registra ANTES de emitir y confirma.
// NFR-TX-001: idempotency key → nunca duplica el efecto. NFR-TX-003: blockhash nuevo si caduca.
// NFR-TX-005: `reconcile()` al arrancar compara con la cadena lo que quedó en SENT.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { firstSignature } from "./sig";
import type { DB } from "../db";
import type { RpcPool } from "./rpc";
import { isNetworkError } from "./rpc";
import type { MessageSigner, PreparedTx, SendErrorCode, SendResult, TxSender } from "./types";
import type { PumpPayload } from "./pumpfun";

export type SenderOpts = { computeUnitLimit: number; priorityMicroLamports: () => number };

export function classify(logs: string[] | null | undefined, err: unknown): { code: SendErrorCode; message: string } {
  const text = `${JSON.stringify(err ?? "")} ${(logs ?? []).join("\n")}`;
  if (/0x1772|0x1773|TooMuchSolRequired|TooLittleSolReceived|slippage/i.test(text)) return { code: "SLIPPAGE", message: "Slippage excedido: el precio se movió más que la tolerancia configurada." };
  if (/0x1775|BondingCurveComplete/i.test(text)) return { code: "CURVE_COMPLETE", message: "La curva está completa; el token se opera en PumpSwap." };
  if (/insufficient lamports|insufficient funds|InsufficientFundsForRent|no record of a prior credit|"Custom":1\b/i.test(text)) return { code: "INSUFFICIENT_FUNDS", message: "Saldo insuficiente para el monto, las fees o el rent." };
  if (/BlockhashNotFound|blockhash not found|block height exceeded/i.test(text)) return { code: "BLOCKHASH_EXPIRED", message: "El blockhash caducó antes de confirmar." };
  if (isNetworkError(err)) return { code: "RPC_DOWN", message: "El RPC no responde." };
  return { code: "SIMULATION_FAILED", message: (logs ?? []).filter((l) => /Error|failed/i.test(l)).slice(-2).join(" · ") || "La simulación falló." };
}

type Row = { idempotency_key: string; status: string; signature: string | null; last_valid_block_height: number | null; error_code: string | null; error: string | null; fee_lamports: number | null };

export class SolanaSender implements TxSender {
  constructor(
    private pool: RpcPool,
    private db: () => DB,
    private sign: MessageSigner,
    private opts: SenderOpts,
  ) {}

  private row(key: string) {
    return this.db().prepare("SELECT * FROM tx WHERE idempotency_key = ?").get(key) as Row | undefined;
  }

  private async build(tx: PreparedTx) {
    const { instructions } = tx.payload as PumpPayload;
    const { blockhash, lastValidBlockHeight } = await this.pool.run((c) => c.getLatestBlockhash("confirmed"));
    const msg = new TransactionMessage({
      payerKey: new PublicKey(tx.payer),
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: this.opts.computeUnitLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.opts.priorityMicroLamports() }), ...instructions],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    const bytes = vtx.message.serialize();
    for (const s of tx.signers) vtx.addSignature(new PublicKey(s), this.sign(s, bytes));
    const signature = firstSignature(vtx);
    return { vtx, blockhash, lastValidBlockHeight, signature };
  }

  async send(tx: PreparedTx, { idempotencyKey, simulateOnly }: { idempotencyKey: string; simulateOnly?: boolean }): Promise<SendResult> {
    const prev = this.row(idempotencyKey);
    if (prev?.status === "CONFIRMED") return { status: "confirmed", signature: prev.signature!, reused: true, feeLamports: prev.fee_lamports != null ? BigInt(prev.fee_lamports) : undefined };
    if (prev?.status === "FAILED" && prev.signature && (await this.statusOf(prev.signature).catch(() => "unknown" as const)) === "confirmed") {
      return this.markConfirmed(idempotencyKey, prev.signature);
    }
    if (prev?.status === "SENT" && prev.signature) {
      const landed = await this.statusOf(prev.signature);
      if (landed === "confirmed") return this.markConfirmed(idempotencyKey, prev.signature);
      if (landed === "failed") return this.markFailed(idempotencyKey, "SIMULATION_FAILED", "La transacción anterior falló en la cadena.", prev.signature);
      const height = await this.pool.run((c) => c.getBlockHeight("confirmed"));
      if (prev.last_valid_block_height && height <= prev.last_valid_block_height) return { status: "failed", code: "UNKNOWN", message: "Confirmación pendiente del envío anterior.", signature: prev.signature };
      // caducó sin aterrizar: se puede volver a firmar con un blockhash nuevo
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      let built: Awaited<ReturnType<SolanaSender["build"]>>;
      try {
        built = await this.build(tx);
      } catch (e) {
        const c = classify(null, e);
        return { status: "failed", code: c.code, message: c.code === "SIMULATION_FAILED" ? String((e as Error).message) : c.message };
      }
      // REQ-LAUNCH-017 / TEST-ENV-003: simular siempre antes de enviar
      const sim = await this.pool.run((c) => c.simulateTransaction(built.vtx, { sigVerify: true, commitment: "confirmed" })).catch((e) => ({ value: { err: e, logs: [] as string[], unitsConsumed: undefined } }));
      if (sim.value.err) {
        const c = classify(sim.value.logs, sim.value.err);
        if (c.code === "BLOCKHASH_EXPIRED" && attempt === 0) continue;
        return { status: "failed", code: c.code, message: c.message };
      }
      if (simulateOnly) return { status: "simulated", unitsConsumed: sim.value.unitsConsumed ?? undefined, logs: sim.value.logs ?? undefined };

      // Registrar antes de emitir: si el proceso muere aquí, la conciliación sabrá qué firma buscar
      const now = Date.now();
      this.db()
        .prepare(
          `INSERT INTO tx(idempotency_key, kind, signature, last_valid_block_height, status, payer, mint, created_at, updated_at) VALUES(?, ?, ?, ?, 'SENT', ?, ?, ?, ?)
           ON CONFLICT(idempotency_key) DO UPDATE SET signature = excluded.signature, last_valid_block_height = excluded.last_valid_block_height, status = 'SENT', updated_at = excluded.updated_at`,
        )
        .run(idempotencyKey, tx.kind, built.signature, built.lastValidBlockHeight, tx.payer, tx.mint ?? null, now, now);

      try {
        await this.broadcast(built.vtx);
        const conf = await this.pool.run((c) => c.confirmTransaction({ signature: built.signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed"));
        if (conf.value.err) {
          const c = classify(null, conf.value.err);
          return this.markFailed(idempotencyKey, c.code, c.message, built.signature);
        }
        return this.markConfirmed(idempotencyKey, built.signature, BigInt(5000 * tx.signers.length) + BigInt(Math.ceil((this.opts.priorityMicroLamports() * this.opts.computeUnitLimit) / 1e6)), sim.value.unitsConsumed ?? undefined);
      } catch (e) {
        // Ya se emitió (o pudo emitirse): un timeout o un corte del WebSocket no dicen si aterrizó.
        // Se pregunta a la cadena antes de decidir, para que un reintento nunca duplique el efecto.
        const c = classify(null, e);
        const landed = await this.statusOf(built.signature).catch(() => "unknown" as const);
        if (landed === "confirmed") return this.markConfirmed(idempotencyKey, built.signature);
        if (landed === "failed") return this.markFailed(idempotencyKey, "SIMULATION_FAILED", "La transacción falló en la cadena.", built.signature);
        if (c.code === "BLOCKHASH_EXPIRED" && attempt === 0) {
          this.db().prepare("UPDATE tx SET status = 'EXPIRED', updated_at = ? WHERE idempotency_key = ?").run(Date.now(), idempotencyKey);
          continue;
        }
        // Estado desconocido: queda en SENT y se informa como pendiente (la conciliación lo resolverá)
        return { status: "failed", code: c.code === "RPC_DOWN" ? "RPC_DOWN" : "UNKNOWN", message: "Confirmación pendiente: no se sabe aún si la transacción aterrizó.", signature: built.signature };
      }
    }
    return { status: "failed", code: "BLOCKHASH_EXPIRED", message: "El blockhash caducó dos veces seguidas." };
  }

  private async broadcast(vtx: VersionedTransaction) {
    for (let i = 0; ; i++) {
      try {
        return await this.pool.run((c) => c.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 3 }));
      } catch (e) {
        // Surfpool trae cuentas de mainnet bajo demanda y a veces el RPC público corta la petición
        if (i < 5 && /Failed to fetch accounts from remote/.test(String((e as Error).message))) {
          await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  private async statusOf(sig: string): Promise<"confirmed" | "failed" | "unknown"> {
    const r = await this.pool.run((c) => c.getSignatureStatuses([sig], { searchTransactionHistory: true }));
    const s = r.value[0];
    if (!s) return "unknown";
    if (s.err) return "failed";
    return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : "unknown";
  }

  private markConfirmed(key: string, signature: string, fee?: bigint, units?: number): SendResult {
    this.db().prepare("UPDATE tx SET status = 'CONFIRMED', signature = ?, fee_lamports = COALESCE(?, fee_lamports), updated_at = ? WHERE idempotency_key = ?").run(signature, fee != null ? Number(fee) : null, Date.now(), key);
    return { status: "confirmed", signature, feeLamports: fee, unitsConsumed: units };
  }

  private markFailed(key: string, code: SendErrorCode, message: string, signature?: string): SendResult {
    this.db().prepare("UPDATE tx SET status = 'FAILED', error_code = ?, error = ?, updated_at = ? WHERE idempotency_key = ?").run(code, message, Date.now(), key);
    return { status: "failed", code, message, signature };
  }

  /** NFR-TX-005: al arrancar, resuelve los envíos que quedaron en SENT. Devuelve cuántos cambiaron. */
  async reconcile() {
    const rows = this.db().prepare("SELECT * FROM tx WHERE status = 'SENT'").all() as Row[];
    let changed = 0;
    for (const r of rows) {
      if (!r.signature) continue;
      const s = await this.statusOf(r.signature).catch(() => "unknown" as const);
      if (s === "confirmed") (this.markConfirmed(r.idempotency_key, r.signature), changed++);
      else if (s === "failed") (this.markFailed(r.idempotency_key, "SIMULATION_FAILED", "Falló en la cadena (conciliación).", r.signature), changed++);
      else {
        const h = await this.pool.run((c) => c.getBlockHeight("confirmed")).catch(() => 0);
        if (h && r.last_valid_block_height && h > r.last_valid_block_height) {
          this.db().prepare("UPDATE tx SET status = 'EXPIRED', updated_at = ? WHERE idempotency_key = ?").run(Date.now(), r.idempotency_key);
          changed++;
        }
      }
    }
    return changed;
  }
}
