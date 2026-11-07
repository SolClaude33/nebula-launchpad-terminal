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
  jitoEnabled: false,
  jitoEndpoint: "",
  jitoTipSol: 0.001,
  slippageBuyPct: 15,
  slippageSellPct: 5,
  priorityFeeSol: 0.0001,
  keyboardLayout: "qwerty",
  theme: "dark",
  ipfsGateway: "https://ipfs.io/ipfs/",
  // REVIEW-F1 P1-4: límites del proveedor de RPC (0 = sin límite). Presets en RPC_PRESETS: Helius Free 8 y 1, Developer 40 y 5.
  rpcMaxRps: 0,
  rpcSendPerSec: 0,
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
  // Separar de más es inocuo (la clave se vuelve a poner tal cual al conectar); separar de menos deja la
  // clave en claro en la base, en GET /settings, en las copias y en el diagnóstico (REVIEW-F1 P2-8).
  // Un parámetro con nombre de clave se separa siempre; las heurísticas, solo en hosts remotos.
  const remote = !isLoopbackHost(u.hostname);
  const params = [...u.searchParams];
  const qi = params.findIndex(([k, v]) => (KEY_PARAMS.test(k) && v.length >= 6) || (remote && tokenLike(v, 20)));
  if (qi >= 0) {
    const [k, v] = params[qi];
    // se reconstruye a mano para no codificar las llaves del marcador
    const q = params.map(([kk, vv], j) => `${encodeURIComponent(kk)}=${j === qi ? RPC_KEY_PLACEHOLDER : encodeURIComponent(vv)}`).join("&");
    return { url: `${u.protocol}//${u.host}${u.pathname}?${q}${u.hash}`, key: v };
  }
  if (!remote) return { url, key: null };
  const segs = u.pathname.split("/");
  const i = segs.findIndex((s) => tokenLike(s, 16));
  if (i >= 0) {
    const key = segs[i];
    segs[i] = RPC_KEY_PLACEHOLDER;
    return { url: `${u.protocol}//${u.host}${segs.join("/")}${u.search}${u.hash}`, key };
  }
  // credencial como subdominio (p. ej. <token>.proveedor.com)
  const labels = u.hostname.split(".");
  const li = labels.slice(0, -2).findIndex((l) => tokenLike(l, 16));
  if (li >= 0) {
    const key = labels[li];
    labels[li] = RPC_KEY_PLACEHOLDER;
    return { url: `${u.protocol}//${labels.join(".")}${u.port ? `:${u.port}` : ""}${u.pathname}${u.search}${u.hash}`, key };
  }
  return { url, key: null };
}

/** Parece una credencial: solo caracteres de token y con dígitos, o muy largo. */
function tokenLike(s: string, min: number) {
  return s.length >= min && /^[A-Za-z0-9_-]+$/.test(s) && (/\d/.test(s) || s.length >= 24);
}

const isLoopbackHost = (h: string) => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(h);


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

type Writable = { write: (...args: never[]) => boolean };
const patched = new WeakSet<object>();

/**
 * REVIEW-F1 P3-14: lo que las librerías imprimen por console.* (p. ej. errores de WebSocket de web3.js) no
 * pasa por pino. Se envuelven stdout y stderr del proceso para que también pase por `scrub`.
 */
export function installOutputScrub(streams: Writable[] = [process.stdout, process.stderr]) {
  for (const stream of streams) {
    if (patched.has(stream)) continue;
    patched.add(stream);
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    (stream as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
      if (known.size > 0) {
        if (typeof chunk === "string") chunk = scrub(chunk);
        else if (chunk instanceof Uint8Array) {
          const text = Buffer.from(chunk).toString("utf8");
          const clean = scrub(text);
          if (clean !== text) {
            chunk = clean;
            if (typeof rest[0] === "string") rest[0] = "utf8";
          }
        }
      }
      return original(chunk, ...rest);
    };
  }
}
