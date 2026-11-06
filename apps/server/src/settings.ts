// REQ-SET-001/002: ajustes en claro (kv `settings`) y secretos cifrados en la bóveda (tabla setting_secret).
// Las URL del RPC se guardan con el marcador {key}; la clave real solo existe descifrada en memoria
// mientras la bóveda está abierta, y cualquier texto que salga del proceso (logs, errores) pasa por `scrub`.
import { RPC_KEY_PLACEHOLDER, type SettingsDto } from "@nebula/shared";
import type { DB } from "./db";
import { kvGet } from "./db";
import type { Vault } from "./signer";

export const SECRET_NAMES = ["ipfsKey", "rpcKey", "rpcBackupKey"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const SETTINGS_DEFAULTS: Omit<SettingsDto, "ipfsKeySet" | "rpcKeySet" | "rpcBackupKeySet" | "autoLockMin"> = {
  rpcPrimaryHttp: "http://127.0.0.1:8899",
  rpcPrimaryWs: "ws://127.0.0.1:8900",
  rpcBackupHttp: "",
  rpcBackupWs: "",
  jitoEndpoint: "",
  jitoTipSol: 0.001,
  slippageBuyPct: 15,
  slippageSellPct: 5,
  priorityFeeSol: 0.0001,
  keyboardLayout: "qwerty",
  theme: "dark",
  ipfsGateway: "https://ipfs.io/ipfs/",
};

export type StoredSettings = typeof SETTINGS_DEFAULTS;

export function storedSettings(db: DB): StoredSettings {
  let raw: Partial<StoredSettings> = {};
  try {
    raw = JSON.parse(kvGet(db, "settings") ?? "{}");
  } catch {}
  return { ...SETTINGS_DEFAULTS, ...raw };
}

export function readSecret(db: DB, vault: Vault, name: SecretName): string | null {
  const r = db.prepare("SELECT ciphertext FROM setting_secret WHERE name = ?").get(name) as { ciphertext: Buffer } | undefined;
  if (!r || !vault.isUnlocked()) return null;
  const v = vault.openSecret(name, r.ciphertext);
  remember(v);
  return v;
}

export const hasSecret = (db: DB, name: SecretName) => !!db.prepare("SELECT 1 FROM setting_secret WHERE name = ?").get(name);

const KEY_PARAMS = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth)$/i;

/**
 * Separa la credencial de una URL de RPC pegada tal cual (Helius `?api-key=…`, QuickNode/Triton con un token
 * en la ruta). Devuelve la URL con {key} y la credencial, o la URL intacta si no lleva ninguna.
 */
export function splitRpcKey(url: string): { url: string; key: string | null } {
  if (!url || url.includes(RPC_KEY_PLACEHOLDER)) return { url, key: null };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url, key: null };
  }
  for (const [k, v] of u.searchParams) {
    if (KEY_PARAMS.test(k) && v.length >= 6) {
      // se reconstruye a mano para no codificar las llaves del marcador
      const rest = [...u.searchParams].filter(([kk]) => kk !== k).map(([kk, vv]) => `${encodeURIComponent(kk)}=${encodeURIComponent(vv)}`);
      const q = [`${encodeURIComponent(k)}=${RPC_KEY_PLACEHOLDER}`, ...rest].join("&");
      return { url: `${u.protocol}//${u.host}${u.pathname}?${q}${u.hash}`, key: v };
    }
  }
  const segs = u.pathname.split("/");
  const i = segs.findIndex((s) => /^[A-Za-z0-9_-]{20,}$/.test(s));
  if (i >= 0) {
    const key = segs[i];
    segs[i] = RPC_KEY_PLACEHOLDER;
    return { url: `${u.protocol}//${u.host}${segs.join("/")}${u.search}${u.hash}`, key };
  }
  return { url, key: null };
}

/** Sustituye {key} por la credencial. Sin credencial disponible (bóveda cerrada o sin configurar) devuelve null. */
export function resolveRpcUrl(url: string, key: string | null): string | null {
  if (!url.includes(RPC_KEY_PLACEHOLDER)) return url;
  if (!key) return null;
  return url.split(RPC_KEY_PLACEHOLDER).join(encodeURIComponent(key));
}

// ── NFR-SEC-004: redacción de secretos por valor en todo lo que sale del proceso ─────
const known = new Set<string>();

/** Registra un secreto descifrado para que nunca aparezca en logs ni mensajes de error. */
export function remember(secret: string | null | undefined) {
  if (secret && secret.length >= 6) {
    known.add(secret);
    known.add(encodeURIComponent(secret));
  }
}

export function scrub(text: string): string {
  let out = text;
  for (const s of known) if (out.includes(s)) out = out.split(s).join("[redactado]");
  return out;
}
