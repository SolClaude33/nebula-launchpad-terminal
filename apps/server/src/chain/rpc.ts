// NFR-TX-002: RPC principal y de respaldo con health checks; si el principal cae, se cambia en ≤ 3 s.
import { Connection } from "@solana/web3.js";

export type Endpoint = { http: string; ws?: string };
export type RpcStatus = { healthy: boolean; host: string | null; latencyMs: number | null; usingBackup: boolean; endpoints: number };

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;
export const isLoopback = (url: string) => {
  try {
    return LOOPBACK.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

const NETWORK_ERR = /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|aborted|socket hang up|50[234]/i;
export const isNetworkError = (e: unknown) => NETWORK_ERR.test(String((e as Error)?.message ?? e));
/** Errores transitorios del propio RPC (límite de peticiones, error interno, fallo al traer cuentas remotas). */
const TRANSIENT_ERR = /Internal error|429|Too Many Requests|rate limit|Failed to fetch accounts from remote|-32603/i;
export const isTransientRpcError = (e: unknown) => TRANSIENT_ERR.test(String((e as Error)?.message ?? e));

type Slot = { ep: Endpoint; conn: Connection; healthy: boolean; latencyMs: number | null };

export class RpcPool {
  private slots: Slot[];
  private active = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(endpoints: Endpoint[], private timeoutMs = 1200) {
    const eps = endpoints.filter((e) => e.http);
    if (eps.length === 0) throw new Error("No hay RPC configurado");
    // Cada petición tiene un tiempo máximo: así un RPC colgado no bloquea el failover
    const fetchWithTimeout: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(Math.max(this.timeoutMs * 4, 8000)) });
    this.slots = eps.map((ep) => ({ ep, conn: new Connection(ep.http, { commitment: "confirmed", wsEndpoint: ep.ws || undefined, fetch: fetchWithTimeout, disableRetryOnRateLimit: true }), healthy: true, latencyMs: null }));
  }

  get endpoints() {
    return this.slots.map((s) => s.ep);
  }

  current(): Connection {
    return this.slots[this.active].conn;
  }

  private async probe(s: Slot) {
    const t = Date.now();
    try {
      await Promise.race([s.conn.getSlot("processed"), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), this.timeoutMs))]);
      s.healthy = true;
      s.latencyMs = Date.now() - t;
    } catch {
      s.healthy = false;
      s.latencyMs = null;
    }
  }

  /** Comprueba todos los endpoints y activa el primero sano (el principal tiene preferencia). */
  async check() {
    await Promise.all(this.slots.map((s) => this.probe(s)));
    const i = this.slots.findIndex((s) => s.healthy);
    if (i >= 0) this.active = i;
  }

  start(intervalMs = 2000) {
    this.timer ??= setInterval(() => void this.check(), intervalMs);
    this.timer.unref?.();
    void this.check();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ejecuta `fn` contra el RPC activo; ante un error de red pasa al siguiente endpoint sano y reintenta. */
  async run<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.slots.length; attempt++) {
      const s = this.slots[this.active];
      try {
        return await this.withRetry(() => fn(s.conn));
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        // Con un solo RPC no hay a dónde cambiar: un timeout (p. ej. el fork de Surfpool trayendo cuentas
        // de mainnet) se reintenta una vez en el mismo endpoint antes de marcarlo como caído
        if (this.slots.length === 1 && attempt === 0 && /timeout/i.test(String((e as Error)?.message ?? e))) {
          try {
            return await this.withRetry(() => fn(s.conn));
          } catch (e2) {
            if (!isNetworkError(e2)) throw e2;
            lastErr = e2;
            s.healthy = false;
            continue;
          }
        }
        lastErr = e;
        s.healthy = false;
        const next = this.slots.findIndex((x, i) => i !== this.active && x.healthy);
        this.active = next >= 0 ? next : (this.active + 1) % this.slots.length;
      }
    }
    throw lastErr;
  }

  /** Reintenta en el mismo endpoint ante errores transitorios del RPC, con espera creciente. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= 3 || !isTransientRpcError(e)) throw e;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  }

  status(): RpcStatus {
    const s = this.slots[this.active];
    let host: string | null = null;
    try {
      host = new URL(s.ep.http).host;
    } catch {}
    return { healthy: s.healthy, host, latencyMs: s.latencyMs, usingBackup: this.active > 0, endpoints: this.slots.length };
  }
}
