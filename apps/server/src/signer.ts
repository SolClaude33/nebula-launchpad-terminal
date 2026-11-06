// signer: ÚNICO módulo con acceso a la bóveda desbloqueada (§5.3, NFR-SEC-002).
// - KEK = Argon2id(contraseña, salt) con libsodium (≥ 64 MiB, ≥ 3 iteraciones; NFR-SEC-001).
// - La KEK envuelve una DEK aleatoria de 32 bytes con AES-256-GCM. La DEK cifra cada clave privada.
// - Cambiar la contraseña solo re-envuelve la DEK: una escritura atómica (REQ-VAULT-006).
// - La contraseña nunca se guarda; una contraseña errónea es un fallo de autenticación GCM.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import type { DB } from "./db";
import { kvGet, kvSet } from "./db";
import { b58decode, b58encode } from "./base58";

export const KDF = { alg: "argon2id13", opslimit: 3, memlimit: 64 * 1024 * 1024 } as const;
const VAULT_VERSION = 1;
const BACKOFF_SEC = [0, 2, 4, 8, 16, 30, 60];

export class VaultError extends Error {
  constructor(
    public code: "NOT_INITIALIZED" | "ALREADY_INITIALIZED" | "LOCKED" | "BAD_PASSWORD" | "RETRY_LATER" | "BAD_STEP_UP",
    message: string,
    public retryInSec = 0,
  ) {
    super(message);
  }
}

let ready: Promise<void> | null = null;
export const sodiumReady = () => (ready ??= sodium.ready);

function deriveKek(password: string, salt: Uint8Array, kdf: { opslimit: number; memlimit: number }) {
  return Buffer.from(sodium.crypto_pwhash(32, password, salt, kdf.opslimit, kdf.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13));
}

export function seal(key: Buffer, aad: string, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

export function open(key: Buffer, aad: string, blob: Buffer): Buffer {
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

type Meta = { kdf: string; salt: Buffer; wrapped_dek: Buffer };

/** Comprueba una contraseña contra la meta de una bóveda (p. ej. la de una copia de seguridad). */
export async function unwrapDek(meta: Meta, password: string): Promise<Buffer | null> {
  await sodiumReady();
  const kdf = JSON.parse(meta.kdf) as { opslimit: number; memlimit: number };
  const kek = deriveKek(password, meta.salt, kdf);
  try {
    return open(kek, "vault:dek", meta.wrapped_dek);
  } catch {
    return null;
  } finally {
    kek.fill(0);
  }
}

export type LockListener = (reason: "manual" | "auto" | "restore") => void;

export class Vault {
  private dek: Buffer | null = null;
  private lastActivity = Date.now();
  private stepUps = new Map<string, { action: string; exp: number }>();
  private listeners: LockListener[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private getDb: () => DB) {}

  private get db() {
    return this.getDb();
  }

  onLock(fn: LockListener) {
    this.listeners.push(fn);
  }

  isInitialized() {
    return !!this.db.prepare("SELECT 1 FROM vault_meta WHERE id = 1").get();
  }

  isUnlocked() {
    return this.dek !== null;
  }

  autoLockMin() {
    return Number(kvGet(this.db, "autoLockMin") ?? 15);
  }

  lockInSec() {
    if (!this.dek) return null;
    return Math.max(0, Math.round((this.lastActivity + this.autoLockMin() * 60_000 - Date.now()) / 1000));
  }

  retryInSec() {
    const next = Number(kvGet(this.db, "unlock.nextAt") ?? 0);
    return Math.max(0, Math.ceil((next - Date.now()) / 1000));
  }

  touch() {
    if (this.dek) this.lastActivity = Date.now();
  }

  startAutoLock() {
    this.timer ??= setInterval(() => {
      if (this.dek && this.lockInSec() === 0) this.lock("auto");
    }, 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lock("manual");
  }

  async setup(password: string) {
    await sodiumReady();
    if (this.isInitialized()) throw new VaultError("ALREADY_INITIALIZED", "La bóveda ya existe.");
    const salt = Buffer.from(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES));
    const kek = deriveKek(password, salt, KDF);
    const dek = randomBytes(32);
    const wrapped = seal(kek, "vault:dek", dek);
    kek.fill(0);
    const now = Date.now();
    this.db
      .prepare("INSERT INTO vault_meta(id, version, kdf, salt, wrapped_dek, created_at, updated_at) VALUES(1, ?, ?, ?, ?, ?, ?)")
      .run(VAULT_VERSION, JSON.stringify(KDF), salt, wrapped, now, now);
    this.dek = dek;
    this.lastActivity = now;
  }

  private meta(): Meta {
    const m = this.db.prepare("SELECT kdf, salt, wrapped_dek FROM vault_meta WHERE id = 1").get() as Meta | undefined;
    if (!m) throw new VaultError("NOT_INITIALIZED", "No hay bóveda. Créala en /setup.");
    return m;
  }

  /**
   * REQ-VAULT-002: toda comprobación de la contraseña actual (desbloquear, reconfirmar, restaurar)
   * comparte el mismo contador; una contraseña errónea no descifra nada y el retardo crece y persiste.
   */
  async checkPassword(password: string): Promise<Buffer> {
    const retry = this.retryInSec();
    if (retry > 0) throw new VaultError("RETRY_LATER", `Espera ${retry} s antes de volver a intentarlo.`, retry);
    const dek = await unwrapDek(this.meta(), password);
    if (!dek) {
      const fails = Number(kvGet(this.db, "unlock.fails") ?? 0) + 1;
      const wait = BACKOFF_SEC[Math.min(fails, BACKOFF_SEC.length - 1)];
      kvSet(this.db, "unlock.fails", String(fails));
      kvSet(this.db, "unlock.nextAt", String(Date.now() + wait * 1000));
      throw new VaultError("BAD_PASSWORD", "Contraseña incorrecta.", wait);
    }
    kvSet(this.db, "unlock.fails", "0");
    kvSet(this.db, "unlock.nextAt", "0");
    return dek;
  }

  async unlock(password: string) {
    const dek = await this.checkPassword(password);
    this.dek?.fill(0);
    this.dek = dek;
    this.lastActivity = Date.now();
  }

  lock(reason: "manual" | "auto" | "restore" = "manual") {
    const was = this.dek !== null;
    this.dek?.fill(0);
    this.dek = null;
    this.stepUps.clear();
    if (was) for (const l of this.listeners) l(reason);
  }

  private requireDek(): Buffer {
    if (!this.dek) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    return this.dek;
  }

  // ── Reconfirmación (REQ-VAULT-004), aplicada en el servidor y con el mismo retardo ─────
  async issueStepUp(password: string, action: string) {
    this.requireDek();
    (await this.checkPassword(password)).fill(0);
    this.touch();
    const token = randomUUID();
    this.stepUps.set(token, { action, exp: Date.now() + 60_000 });
    return { token, expiresInSec: 60 };
  }

  consumeStepUp(token: string | undefined, action: string) {
    this.requireDek();
    const e = token ? this.stepUps.get(token) : undefined;
    if (token) this.stepUps.delete(token);
    if (!e || e.exp < Date.now() || e.action.length !== action.length || !timingSafeEqual(Buffer.from(e.action), Buffer.from(action)))
      throw new VaultError("BAD_STEP_UP", "Reconfirma la contraseña para esta acción.");
  }

  /** REQ-VAULT-006: re-envuelve la DEK en una sola escritura; si se interrumpe, la meta anterior sigue intacta. */
  async changePassword(newPassword: string) {
    const dek = this.requireDek();
    await sodiumReady();
    const salt = Buffer.from(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES));
    const kek = deriveKek(newPassword, salt, KDF);
    const wrapped = seal(kek, "vault:dek", dek);
    kek.fill(0);
    this.db.prepare("UPDATE vault_meta SET kdf = ?, salt = ?, wrapped_dek = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(KDF), salt, wrapped, Date.now());
  }

  // ── Claves ─────────────────────────────────────────
  async generateKey(): Promise<{ address: string; sk: Buffer }> {
    await sodiumReady();
    const kp = sodium.crypto_sign_keypair();
    return { address: b58encode(kp.publicKey), sk: Buffer.from(kp.privateKey) };
  }

  sealKey(walletId: string, sk: Buffer) {
    const blob = seal(this.requireDek(), `wallet:${walletId}`, sk);
    sk.fill(0);
    return blob;
  }

  /** Solo para el flujo de exportación (REQ-WAL-006). Devuelve base58 y limpia el buffer. */
  revealKey(walletId: string, blob: Buffer) {
    const sk = open(this.requireDek(), `wallet:${walletId}`, blob);
    const out = b58encode(sk);
    sk.fill(0);
    return out;
  }

  sealSecret(name: string, value: string) {
    return seal(this.requireDek(), `setting:${name}`, Buffer.from(value, "utf8"));
  }

  openSecret(name: string, blob: Buffer) {
    return open(this.requireDek(), `setting:${name}`, blob).toString("utf8");
  }
}

/** Interpreta una línea de importación: base58 de 64 bytes (formato Phantom), de 32 bytes (seed) o array JSON de 64 números. */
export async function parseSecret(line: string): Promise<{ address: string; sk: Buffer } | { error: string }> {
  await sodiumReady();
  const s = line.trim();
  let bytes: Uint8Array | null = null;
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) bytes = Uint8Array.from(arr);
    } catch {
      return { error: "JSON inválido" };
    }
  } else bytes = b58decode(s);
  if (!bytes) return { error: "No es base58 ni un array JSON" };
  let kp: { publicKey: Uint8Array; privateKey: Uint8Array };
  if (bytes.length === 64) {
    kp = sodium.crypto_sign_seed_keypair(bytes.subarray(0, 32));
    if (!Buffer.from(kp.publicKey).equals(Buffer.from(bytes.subarray(32)))) return { error: "La clave pública no corresponde a la privada" };
  } else if (bytes.length === 32) kp = sodium.crypto_sign_seed_keypair(bytes);
  else return { error: `Longitud ${bytes.length} bytes; se esperan 64 (o 32)` };
  bytes.fill(0);
  return { address: b58encode(kp.publicKey), sk: Buffer.from(kp.privateKey) };
}
