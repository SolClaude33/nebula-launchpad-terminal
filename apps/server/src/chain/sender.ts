// tx-sender (§5.3): compila v0, firma con la bóveda, simula, registra ANTES de emitir y confirma.
// NFR-TX-001: idempotency key → nunca duplica el efecto. NFR-TX-003: blockhash nuevo si caduca.
// NFR-TX-005: `reconcile()` al arrancar compara con la cadena lo que quedó en SENT.
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { firstSignature } from "./sig";
import { txFee } from "./fees";
import type { DB } from "../db";
import { VaultError } from "../signer";
import type { RpcPool } from "./rpc";
import { isNetworkError, isRateLimited } from "./rpc";
import type { MessageSigner, PreparedTx, SendErrorCode, SendResult, TxSender } from "./types";
import type { PumpPayload } from "./pumpfun";
import { JITO_OFF, JitoClient, MAX_TX_BYTES, tipFor, tipInstruction, type JitoConfig } from "./jito";

/**
 * `rebroadcastMs`: cada cuánto se reenvía la MISMA transacción firmada mientras se espera la confirmación (0 = nunca).
 * `jito`: configuración de Jito, leída en cada envío (Ajustes la cambia sin reconectar). `fetch`: el del Block Engine (tests).
 */
export type SenderOpts = { computeUnitLimit: number; priorityMicroLamports: () => number; rebroadcastMs?: number; jito?: () => JitoConfig; fetch?: typeof fetch };

/** Por defecto, un reenvío cada 2 s: con Helius Free (1 envío/s) deja cupo a los envíos nuevos. */
export const REBROADCAST_MS = 2000;

export function classify(logs: string[] | null | undefined, err: unknown): { code: SendErrorCode; message: string } {
  // Un Error de JS se serializa como «{}»: su nombre y su mensaje se añaden aparte (p. ej. «block height exceeded»)
  const errText = err instanceof Error ? `${err.name}: ${err.message}` : "";
  const text = `${JSON.stringify(err ?? "")} ${errText} ${(logs ?? []).join("\n")}`;
  if (/0x1772|0x1773|TooMuchSolRequired|TooLittleSolReceived|slippage/i.test(text)) return { code: "SLIPPAGE", message: "Slippage excedido: el precio se movió más que la tolerancia configurada." };
  if (/0x1775|BondingCurveComplete/i.test(text)) return { code: "CURVE_COMPLETE", message: "La curva está completa; el token se opera en PumpSwap." };
  if (/InsufficientFundsForRent|insufficient funds for rent/i.test(text)) return { code: "RENT", message: "Una cuenta quedaría por debajo del mínimo exento de rent (≈ 0,00089 SOL)." };
  if (/insufficient lamports|insufficient funds|no record of a prior credit|"Custom":1\b/i.test(text)) return { code: "INSUFFICIENT_FUNDS", message: "Saldo insuficiente para el monto, las fees o el rent." };
  if (/BlockhashNotFound|blockhash not found|block height exceeded/i.test(text)) return { code: "BLOCKHASH_EXPIRED", message: "El blockhash caducó antes de confirmar." };
  if (isNetworkError(err)) return { code: "RPC_DOWN", message: "El RPC no responde." };
  return { code: "SIMULATION_FAILED", message: (logs ?? []).filter((l) => /Error|failed/i.test(l)).slice(-2).join(" · ") || "La simulación falló." };
}

type Row = { idempotency_key: string; status: string; signature: string | null; last_valid_block_height: number | null; error_code: string | null; error: string | null; fee_lamports: number | null; tip_lamports: number | null };

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

  private price = 0;
  private jitoClient: JitoClient | null = null;
  /** Envíos al Block Engine simulados (perfil `test`): la propina va en la tx, pero no sale nada hacia Jito. */
  readonly jitoSimulated = { count: 0 };

  /** Fee exacta de una tx: la misma que se muestra en la vista previa. */
  feeOf(tx: PreparedTx) {
    return txFee(tx.signers.length, tx.cuLimit ?? this.opts.computeUnitLimit, this.opts.priorityMicroLamports());
  }

  jitoConfig(): JitoConfig {
    return this.opts.jito?.() ?? JITO_OFF;
  }

  /** Cliente del Block Engine; null si Jito está apagado o simulado (en `test` nunca se llama a Jito). */
  jito(): JitoClient | null {
    const cfg = this.jitoConfig();
    if (!cfg.enabled || cfg.simulated || !cfg.endpoint) return null;
    if (this.jitoClient?.endpoint !== cfg.endpoint) this.jitoClient = new JitoClient(cfg.endpoint, this.opts.fetch ?? fetch);
    return this.jitoClient;
  }

  private async build(tx: PreparedTx, key: string) {
    this.price = this.opts.priorityMicroLamports();
    const { instructions } = tx.payload as PumpPayload;
    const { blockhash, lastValidBlockHeight } = await this.pool.run((c) => c.getLatestBlockhash("confirmed"));
    const compile = (tip: bigint) =>
      new TransactionMessage({
        payerKey: new PublicKey(tx.payer),
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: tx.cuLimit ?? this.opts.computeUnitLimit }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.price }),
          ...instructions,
          // Propina al final de la MISMA tx: si la operación falla, no se paga (lo que recomienda Jito)
          ...(tip > 0n ? [tipInstruction(tx.payer, tip, key)] : []),
        ],
      }).compileToV0Message(tx.lookupTables);
    let tipLamports = tipFor(tx.kind, this.jitoConfig());
    let vtx = new VersionedTransaction(compile(tipLamports));
    // La creación con dev buy va justa: si la propina no cabe en 1.232 bytes, esa tx sale sin propina y solo por el
    // RPC normal. Nunca se parte la creación del dev buy ni se paga una propina en una tx aparte. Es determinista:
    // con la misma configuración, el dry-run y el envío deciden lo mismo.
    if (tipLamports > 0n && vtx.serialize().length > MAX_TX_BYTES) {
      tipLamports = 0n;
      vtx = new VersionedTransaction(compile(0n));
    }
    const bytes = vtx.message.serialize();
    for (const s of tx.signers) vtx.addSignature(new PublicKey(s), this.sign(s, bytes));
    const signature = firstSignature(vtx);
    return { vtx, blockhash, lastValidBlockHeight, signature, tipLamports };
  }

  async send(tx: PreparedTx, { idempotencyKey, simulateOnly, watch }: { idempotencyKey: string; simulateOnly?: boolean; watch?: string }): Promise<SendResult> {
    const prev = this.row(idempotencyKey);
    if (prev?.status === "CONFIRMED") return { status: "confirmed", signature: prev.signature!, reused: true, feeLamports: prev.fee_lamports != null ? BigInt(prev.fee_lamports) : undefined, tipLamports: BigInt(prev.tip_lamports ?? 0) };
    if (prev?.status === "FAILED" && prev.signature && (await this.statusOf(prev.signature).catch(() => "unknown" as const)) === "confirmed") {
      return this.markConfirmed(idempotencyKey, prev.signature);
    }
    if (prev?.status === "SENT" && prev.signature) {
      const landed = await this.statusOf(prev.signature);
      if (landed === "confirmed") return this.markConfirmed(idempotencyKey, prev.signature);
      if (landed === "failed") return this.markFailed(idempotencyKey, "SIMULATION_FAILED", "La transacción anterior falló en la cadena.", prev.signature);
      const height = await this.pool.run((c) => c.getBlockHeight("confirmed"));
      if (prev.last_valid_block_height && height <= prev.last_valid_block_height) return { status: "pending", message: "Confirmación pendiente del envío anterior.", signature: prev.signature };
      // caducó sin aterrizar: se puede volver a firmar con un blockhash nuevo
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      let built: Awaited<ReturnType<SolanaSender["build"]>>;
      try {
        built = await this.build(tx, idempotencyKey);
      } catch (e) {
        // Bóveda bloqueada o clave ausente: no se ha emitido nada; quien llama decide (pausar)
        if (e instanceof VaultError) throw e;
        const c = classify(null, e);
        if (c.code === "RPC_DOWN") return { status: "pending", message: "El RPC no responde; no se ha enviado nada todavía." };
        return { status: "failed", code: c.code, message: c.code === "SIMULATION_FAILED" ? String((e as Error).message) : c.message };
      }
      // REQ-LAUNCH-017 / TEST-ENV-003: simular siempre antes de enviar
      const sim = await this.pool
        .run((c) => c.simulateTransaction(built.vtx, { sigVerify: true, commitment: "confirmed", ...(watch ? { accounts: { encoding: "base64" as const, addresses: [watch] } } : {}) }))
        .catch((e) => ({ value: { err: e, logs: [] as string[], unitsConsumed: undefined, accounts: undefined } }));
      if (sim.value.err) {
        const c = classify(sim.value.logs, sim.value.err);
        if (c.code === "BLOCKHASH_EXPIRED" && attempt === 0) continue;
        if (c.code === "RPC_DOWN") return { status: "pending", message: "El RPC no responde; no se ha enviado nada todavía." };
        return { status: "failed", code: c.code, message: c.message };
      }
      if (simulateOnly) {
        const acc = sim.value.accounts?.[0];
        return { status: "simulated", unitsConsumed: sim.value.unitsConsumed ?? undefined, logs: sim.value.logs ?? undefined, tipLamports: built.tipLamports, ...(watch ? { postLamports: BigInt(acc?.lamports ?? 0) } : {}) };
      }

      // Registrar antes de emitir: si el proceso muere aquí, la conciliación sabrá qué firma buscar
      const now = Date.now();
      this.db()
        .prepare(
          `INSERT INTO tx(idempotency_key, kind, signature, last_valid_block_height, status, payer, mint, tip_lamports, created_at, updated_at) VALUES(?, ?, ?, ?, 'SENT', ?, ?, ?, ?, ?)
           ON CONFLICT(idempotency_key) DO UPDATE SET signature = excluded.signature, last_valid_block_height = excluded.last_valid_block_height, status = 'SENT', tip_lamports = excluded.tip_lamports, updated_at = excluded.updated_at`,
        )
        .run(idempotencyKey, tx.kind, built.signature, built.lastValidBlockHeight, tx.payer, tx.mint ?? null, Number(built.tipLamports), now, now);

      // Jito: los MISMOS bytes firmados (misma firma) salen también por el Block Engine, sin esperar ni tocar el resultado
      const live = { done: false };
      const jito = built.tipLamports > 0n ? this.jito() : null;
      if (jito) void jito.send(built.vtx.serialize(), { wait: true, alive: () => !live.done });
      else if (built.tipLamports > 0n) this.jitoSimulated.count++;

      try {
        await this.broadcast(built.vtx);
        const stopRebroadcast = this.rebroadcast(built.vtx, jito, () => (live.done = true));
        let conf: Awaited<ReturnType<import("@solana/web3.js").Connection["confirmTransaction"]>>;
        try {
          conf = await this.pool.run((c) => c.confirmTransaction({ signature: built.signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed"));
        } finally {
          stopRebroadcast();
        }
        if (conf.value.err) {
          const c = classify(null, conf.value.err);
          return this.markFailed(idempotencyKey, c.code, c.message, built.signature);
        }
        return this.markConfirmed(idempotencyKey, built.signature, txFee(tx.signers.length, tx.cuLimit ?? this.opts.computeUnitLimit, this.price), sim.value.unitsConsumed ?? undefined, built.tipLamports);
      } catch (e) {
        // Ya se emitió (o pudo emitirse): un timeout o un corte del WebSocket no dicen si aterrizó.
        // Se pregunta a la cadena antes de decidir, para que un reintento nunca duplique el efecto.
        const c = classify(null, e);
        const landed = await this.statusOf(built.signature).catch(() => "unknown" as const);
        if (landed === "confirmed") return this.markConfirmed(idempotencyKey, built.signature);
        if (landed === "failed") return this.markFailed(idempotencyKey, "SIMULATION_FAILED", "La transacción falló en la cadena.", built.signature);
        if (c.code === "BLOCKHASH_EXPIRED") {
          // Caducó sin aterrizar: ya no puede entrar, así que volver a firmar con un blockhash nuevo no duplica nada
          this.db().prepare("UPDATE tx SET status = 'EXPIRED', updated_at = ? WHERE idempotency_key = ?").run(Date.now(), idempotencyKey);
          if (attempt === 0) continue;
          return { status: "failed", code: "BLOCKHASH_EXPIRED", message: "La red no incluyó la transacción y su blockhash caducó dos veces. No se cobró nada.", signature: built.signature };
        }
        // Estado desconocido: queda en SENT y se informa como pendiente (la conciliación lo resolverá)
        void c;
        return { status: "pending", message: "Confirmación pendiente: no se sabe aún si la transacción aterrizó.", signature: built.signature };
      }
    }
    return { status: "failed", code: "BLOCKHASH_EXPIRED", message: "El blockhash caducó dos veces seguidas." };
  }

  /**
   * Reenvía los MISMOS bytes firmados (misma firma: nunca duplica) cada `rebroadcastMs` hasta que se llame a la
   * función devuelta. Solo usa cupo sobrante del limitador, así que nunca retrasa un envío nuevo.
   */
  private rebroadcast(vtx: VersionedTransaction, jito: JitoClient | null = null, onStop: () => void = () => {}) {
    const every = this.opts.rebroadcastMs ?? REBROADCAST_MS;
    if (every <= 0 || typeof this.pool.tryRun !== "function") return onStop;
    const raw = vtx.serialize();
    let done = false;
    const timer = setInterval(() => {
      if (done) return;
      void this.pool.tryRun((c) => c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }), { send: true }).catch(() => {});
      // también al Block Engine, solo con cupo sobrante de su propio limitador
      if (jito) void jito.send(raw, { wait: false, alive: () => !done });
    }, every);
    timer.unref?.();
    return () => {
      done = true;
      onStop();
      clearInterval(timer);
    };
  }

  private async broadcast(vtx: VersionedTransaction) {
    for (let i = 0; ; i++) {
      try {
        return await this.pool.run((c) => c.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 3 }), { send: true });
      } catch (e) {
        // REVIEW-F1 P1-4: un 429 significa que el RPC no aceptó la transacción: se reenvía la MISMA
        // transacción firmada (misma firma: nunca duplica) en vez de dejar la orden pendiente y en pausa
        if (i < 5 && isRateLimited(e)) {
          await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
          continue;
        }
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

  private markConfirmed(key: string, signature: string, fee?: bigint, units?: number, tip?: bigint): SendResult {
    this.db().prepare("UPDATE tx SET status = 'CONFIRMED', signature = ?, fee_lamports = COALESCE(?, fee_lamports), updated_at = ? WHERE idempotency_key = ?").run(signature, fee != null ? Number(fee) : null, Date.now(), key);
    return { status: "confirmed", signature, feeLamports: fee, unitsConsumed: units, ...(tip !== undefined ? { tipLamports: tip } : {}) };
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
