// F2 · bloque 5 (REQ-SET-001, NFR-TX-003): Jito como vía de envío opcional.
// - Compra, venta y creación sueltas: UNA propina dentro de la MISMA transacción, y esos bytes salen por el RPC y por
//   `sendTransaction` del Block Engine. No hay una tx de propina aparte (Jito avisa del «uncle bandit»).
// - Bundle de lanzamiento (aparte): `sendBundle` en `/api/v1/bundles`, como máximo 5 transacciones, secuenciales y
//   atómicas (docs.jito.wtf, «Low Latency Transaction Send»). La propina va en la última transacción del bundle, no
//   en una tx suelta. Recibir un bundle_id no significa que haya aterrizado: eso lo dice `getInflightBundleStatuses`
//   y, de verdad, la cadena. El snipe no entra en ese bundle: compra después, por el sender normal.
// - La cuenta de propina se elige de forma determinista (hash de la idempotency key), nunca al azar.
// - La cuenta de propina nunca va en una tabla de direcciones (lo pide Jito): se añade en el sender, no en el
//   adaptador, para que `staticLaunchKeys` no la meta en la tabla de Nébula.
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { TokenBucket } from "./rpc";
import type { PreparedTx } from "./types";

/** Lista oficial de cuentas de propina de mainnet (docs.jito.wtf/lowlatencytxnsend, «han permanecido constantes»; 2026-11-07). */
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

/** Propina mínima que acepta Jito (docs.jito.wtf: 1.000 lamports). */
export const JITO_MIN_TIP_LAMPORTS = 1_000n;
/** Un bundle son como máximo 5 transacciones (docs.jito.wtf). La creación ocupa una. */
export const JITO_MAX_BUNDLE_TXS = 5;
export const MAX_BUNDLE_BUYS = JITO_MAX_BUNDLE_TXS - 1;

/**
 * Cómo se puede mandar un bundle de lanzamiento sin llamar a la red.
 * `block-engine`: `sendBundle` de verdad. `mock`: el libro local lo aplica atómico y lo marca simulado.
 * `unavailable`: Jito apagado, o simulado contra un RPC (Surfpool no tiene Block Engine y el RPC no es un bundle).
 */
export type BundleTransport = "block-engine" | "mock" | "unavailable";
export function bundleTransport(cfg: JitoConfig, kind: "mock" | "rpc" | "off"): BundleTransport {
  if (!cfg.enabled || cfg.tipLamports < JITO_MIN_TIP_LAMPORTS || !cfg.endpoint) return "unavailable";
  if (kind === "mock") return "mock";
  if (cfg.simulated || kind !== "rpc") return "unavailable";
  return "block-engine";
}
/** Tamaño máximo de una transacción de Solana. */
export const MAX_TX_BYTES = 1232;
/** Solo las operaciones de mercado propias llevan propina; reclamos, transferencias y quemas no. */
export const TIP_KINDS: ReadonlySet<PreparedTx["kind"]> = new Set(["create", "buy", "sell"]);

/**
 * `simulated`: perfil `test` (Surfpool) o mock. La propina va en la transacción (así se miden tamaño, coste y P&L de
 * verdad), pero nunca se llama al Block Engine: Jito no existe en un fork local.
 */
export type JitoConfig = { enabled: boolean; tipLamports: bigint; endpoint: string; simulated: boolean };
export const JITO_OFF: JitoConfig = { enabled: false, tipLamports: 0n, endpoint: "", simulated: true };

/** Propina de una operación con la configuración dada: la MISMA para la vista previa, el dry-run y el envío. */
export const tipFor = (kind: PreparedTx["kind"], cfg: JitoConfig) => (cfg.enabled && cfg.tipLamports >= JITO_MIN_TIP_LAMPORTS && TIP_KINDS.has(kind) ? cfg.tipLamports : 0n);

/** Cuenta de propina determinista para una idempotency key (reparte la contención sin aleatoriedad). */
export function tipAccountFor(key: string) {
  const h = createHash("sha256").update(key).digest();
  return new PublicKey(JITO_TIP_ACCOUNTS[h[0] % JITO_TIP_ACCOUNTS.length]);
}

export const tipInstruction = (payer: string, lamports: bigint, key: string): TransactionInstruction =>
  SystemProgram.transfer({ fromPubkey: new PublicKey(payer), toPubkey: tipAccountFor(key), lamports });

export type JitoStats = { sent: number; failed: number; simulated: number; skipped: number; lastError: string | null };

/**
 * Cliente mínimo de `sendTransaction` del Block Engine. Nunca lanza: un fallo de Jito no cambia el resultado del
 * envío (el RPC normal es la fuente de verdad). Límite propio de 1 petición/s (el de Jito sin autenticación).
 */
export class JitoClient {
  private bucket: TokenBucket;
  readonly stats: JitoStats = { sent: 0, failed: 0, simulated: 0, skipped: 0, lastError: null };

  constructor(
    readonly endpoint: string,
    private fetchImpl: typeof fetch = fetch,
    rps = 1,
  ) {
    this.bucket = new TokenBucket(rps);
  }

  get url() {
    return `${this.endpoint.replace(/\/+$/, "")}/api/v1/transactions`;
  }

  private endpointUrl(path: string) {
    return `${this.endpoint.replace(/\/+$/, "")}${path}`;
  }

  private async rpc(path: string, method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: string; transport: boolean }> {
    await this.bucket.take(1);
    try {
      const res = await this.fetchImpl(this.endpointUrl(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
      if (!res.ok || !body || body.error) {
        const error = body?.error?.message ?? `HTTP ${res.status}`;
        this.stats.failed++;
        this.stats.lastError = error;
        return { ok: false, error, transport: false };
      }
      return { ok: true, result: body.result };
    } catch (e) {
      this.stats.failed++;
      this.stats.lastError = String((e as Error)?.message ?? e).slice(0, 200);
      return { ok: false, error: this.stats.lastError, transport: true };
    }
  }

  /**
   * `sendBundle` (POST `/api/v1/bundles`). El `result` es el bundle_id que devuelve Jito: recibirlo no significa
   * que el bundle haya aterrizado. No se inventa un id si la respuesta no trae una cadena.
   */
  async sendBundle(raws: Uint8Array[]): Promise<{ ok: true; bundleId: string } | { ok: false; error: string; transport: boolean }> {
    if (raws.length < 1 || raws.length > JITO_MAX_BUNDLE_TXS) {
      const error = `Un bundle admite de 1 a ${JITO_MAX_BUNDLE_TXS} transacciones (Jito); se iban a enviar ${raws.length}.`;
      this.stats.failed++;
      this.stats.lastError = error;
      return { ok: false, error, transport: false };
    }
    const sent = await this.rpc("/api/v1/bundles", "sendBundle", [raws.map((raw) => Buffer.from(raw).toString("base64")), { encoding: "base64" }]);
    if (!sent.ok) return sent;
    if (typeof sent.result !== "string" || !sent.result) {
      const error = "El Block Engine no devolvió un bundle_id.";
      this.stats.failed++;
      this.stats.lastError = error;
      return { ok: false, error, transport: false };
    }
    this.stats.sent++;
    return { ok: true, bundleId: sent.result };
  }

  /**
   * `getInflightBundleStatuses` (POST `/api/v1/getInflightBundleStatuses`). `unknown` si no está (la doc devuelve
   * null): no es lo mismo que Landed. Pending / Landed / Failed / Invalid son los estados que documenta Jito.
   */
  async inflight(bundleId: string): Promise<{ status: "Pending" | "Landed" | "Failed" | "Invalid" | "unknown"; error?: string }> {
    const sent = await this.rpc("/api/v1/getInflightBundleStatuses", "getInflightBundleStatuses", [[bundleId]]);
    if (!sent.ok) return { status: "unknown", error: sent.error };
    const value = (sent.result as { value?: { status?: string }[] | null } | null)?.value;
    const status = value?.[0]?.status;
    if (status === "Pending" || status === "Landed" || status === "Failed" || status === "Invalid") return { status };
    return { status: "unknown" };
  }

  /**
   * `wait`: el primer envío espera su turno del limitador (sin bloquear a quien llama, que no lo espera); los
   * reenvíos solo usan cupo sobrante. `alive()`: si ya no hace falta (confirmada o caducada), no se envía.
   */
  async send(raw: Uint8Array, opts: { wait: boolean; alive?: () => boolean }): Promise<"sent" | "failed" | "skipped"> {
    let waited = false;
    if (opts.wait) waited = await this.bucket.take(1);
    else if (!this.bucket.tryTake(1)) return (this.stats.skipped++, "skipped");
    // tras esperar turno (o en un reenvío), si ya no hace falta, no se envía
    if ((waited || !opts.wait) && opts.alive && !opts.alive()) return (this.stats.skipped++, "skipped");
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // base58 es el valor por defecto (y obsoleto) del Block Engine: base64 explícito
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(raw).toString("base64"), { encoding: "base64" }] }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
      if (!res.ok || !body || body.error || typeof body.result !== "string") {
        this.stats.failed++;
        this.stats.lastError = body?.error?.message ?? `HTTP ${res.status}`;
        return "failed";
      }
      this.stats.sent++;
      return "sent";
    } catch (e) {
      this.stats.failed++;
      this.stats.lastError = String((e as Error)?.message ?? e).slice(0, 200);
      return "failed";
    }
  }
}
