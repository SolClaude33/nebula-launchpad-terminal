// Crea (y recrea al cambiar los ajustes) la conexión a la cadena según el perfil y el RPC configurado.
import { JITO_DEFAULT_ENDPOINT, RPC_KEY_PLACEHOLDER, type Profile } from "@nebula/shared";
import { kvGet, type DB } from "./db";
import { readSecret, resolveRpcUrl, scrub, storedSettings } from "./settings";
import type { Vault } from "./signer";
import { ChainConfigError, createChain, type Chain } from "./chain";
import type { Endpoint } from "./chain/rpc";
import { JITO_MIN_TIP_LAMPORTS, tipFor, type JitoConfig } from "./chain/jito";
import type { PreparedTx } from "./chain/types";
import { solToLamports } from "./chain/types";

export type ChainState = { mode: "rpc" | "mock" | "off"; healthy: boolean; host: string | null; latencyMs: number | null; usingBackup: boolean; error: string | null };

export class ChainManager {
  private chain: Chain | null = null;
  private error: string | null = null;

  constructor(
    private opts: { profile: Profile; mode: "rpc" | "mock"; db: () => DB; vault: Vault; log: (msg: string) => void; fetch?: typeof fetch },
  ) {}

  /** Endpoints con la clave del RPC ya sustituida; si una URL necesita su clave y la bóveda está cerrada, error claro. */
  private endpoints(): Endpoint[] {
    const db = this.opts.db();
    const s = storedSettings(db);
    const key = readSecret(db, this.opts.vault, "rpcKey");
    const backupKey = readSecret(db, this.opts.vault, "rpcBackupKey");
    const res = (u: string, k: string | null, label: string) => {
      const r = resolveRpcUrl(u, k);
      if (r === null) throw new ChainConfigError(this.opts.vault.isUnlocked() ? `Falta la clave del RPC ${label}. Añádela en Ajustes.` : "Desbloquea la bóveda para conectar el RPC (su clave va cifrada).");
      return r;
    };
    const eps: Endpoint[] = [{ http: res(s.rpcPrimaryHttp, key, "principal"), ws: s.rpcPrimaryWs ? res(s.rpcPrimaryWs, key, "principal") : undefined }];
    if (s.rpcBackupHttp) eps.push({ http: res(s.rpcBackupHttp, backupKey, "de respaldo"), ws: s.rpcBackupWs ? res(s.rpcBackupWs, backupKey, "de respaldo") : undefined });
    return eps;
  }

  /** ¿Alguna URL usa {key}? Entonces al bloquear se desconecta (la clave no se queda en memoria). */
  usesKey() {
    const s = storedSettings(this.opts.db());
    return [s.rpcPrimaryHttp, s.rpcPrimaryWs, s.rpcBackupHttp, s.rpcBackupWs].some((u) => u.includes(RPC_KEY_PLACEHOLDER));
  }

  private priority() {
    const s = JSON.parse(kvGet(this.opts.db(), "settings") ?? "{}") as { priorityFeeSol?: number };
    // priority fee (SOL por tx) → microlamports por CU con un límite de 400k CU
    const sol = s.priorityFeeSol ?? 0.0001;
    return Math.max(1, Math.round((sol * 1e9 * 1e6) / 400_000));
  }

  /**
   * F2 · bloque 5: configuración de Jito leída de Ajustes en cada envío y en cada vista previa (sin reconectar).
   * En el perfil `test` y con el mock, el envío al Block Engine se simula: la propina va en la tx, pero nunca se
   * llama a Jito (no existe en Surfpool y una tx del fork jamás debe salir hacia mainnet).
   */
  jito(): JitoConfig {
    const s = storedSettings(this.opts.db());
    const tipLamports = solToLamports(s.jitoTipSol ?? 0);
    return {
      enabled: !!s.jitoEnabled && tipLamports >= JITO_MIN_TIP_LAMPORTS,
      tipLamports,
      endpoint: s.jitoEndpoint || JITO_DEFAULT_ENDPOINT,
      simulated: this.opts.profile === "test" || this.opts.mode === "mock",
    };
  }

  /** Propina de Jito de una operación (0 si no lleva): la misma que pone el sender. */
  tipFor(kind: PreparedTx["kind"]) {
    return tipFor(kind, this.jito());
  }

  /** (Re)conecta. Si la configuración no es válida para el perfil, la cadena queda desactivada con el motivo. */
  reload() {
    this.chain?.stop();
    this.chain = null;
    this.error = null;
    try {
      this.chain = createChain({
        profile: this.opts.profile,
        mode: this.opts.mode,
        endpoints: this.endpoints(),
        db: this.opts.db,
        sign: (a, m) => this.opts.vault.signMessage(a, m),
        priorityMicroLamports: () => this.priority(),
        limits: { rps: storedSettings(this.opts.db()).rpcMaxRps, sendRps: storedSettings(this.opts.db()).rpcSendPerSec },
        jito: () => this.jito(),
        fetch: this.opts.fetch,
      });
      // NFR-TX-005: conciliar lo que quedó en SENT de una ejecución anterior
      this.chain.reconcile().then(
        (n) => n && this.opts.log(`Conciliación: ${n} envíos actualizados`),
        () => {},
      );
    } catch (e) {
      this.error = scrub(e instanceof ChainConfigError ? e.message : `No se pudo conectar al RPC: ${(e as Error).message}`);
    }
  }

  get(): Chain {
    if (!this.chain) throw Object.assign(new Error(this.error ?? "La cadena no está conectada."), { statusCode: 409 });
    return this.chain;
  }

  state(): ChainState {
    if (!this.chain) return { mode: "off", healthy: false, host: null, latencyMs: null, usingBackup: false, error: this.error };
    const s = this.chain.status();
    // el host puede llevar la clave (credencial en el subdominio): siempre pasa por la redacción
    return { mode: this.chain.kind, healthy: s.healthy, host: s.host ? scrub(s.host) : null, latencyMs: s.latencyMs, usingBackup: s.usingBackup, error: null };
  }

  stop() {
    this.chain?.stop();
  }
}
