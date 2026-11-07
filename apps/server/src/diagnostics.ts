// REQ-LOG-001 / NFR-SEC-004: «Exportar diagnóstico». Junta el estado de la app, la actividad reciente y la
// cola del log técnico en un JSON y lo redacta antes de que salga del proceso:
// - por valor: los secretos de Ajustes (descifrados solo para buscarlos), el token de sesión y cualquier
//   secreto registrado en `remember`;
// - por patrón: claves privadas (base58 de 64 bytes, arrays JSON de 64 o 32 números), JWT, claves de API
//   con nombre, credenciales en URL (parámetro, segmento o subdominio) y cabeceras de autorización;
// - las cadenas base58 de 32 bytes (semilla o dirección: mismo formato) se acortan a `abcd…wxyz`, salvo las
//   direcciones que la app ya conoce (wallets, mints, libreta, traders del Live y programas).
// Nunca incluye claves de wallets (no se descifran aquí) ni el contenido de la bóveda.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { version as nodeVersion } from "node:process";
import type { Ctx } from "./app";
import { logActivity } from "./db";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { readSecret, remember, scrub, SECRET_NAMES, splitRpcKey, storedSettings } from "./settings";

const LOG_TAIL_BYTES = 512 * 1024;

// claves privadas de Solana en base58 (64 bytes ≈ 86-88 caracteres)
const B58_64 = /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g;
// semillas de 32 bytes y direcciones (32-44 caracteres): no se distinguen por el formato (REVIEW-F1 P3-12)
const B58_32 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>\\]+/gi;
// programas que aparecen a menudo en los logs y no son secretos
const PROGRAMS = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  PUMP_PROGRAM_ID.toBase58(),
  PUMP_AMM_PROGRAM_ID.toBase58(),
];
const PATTERNS: [RegExp, string][] = [
  // arrays de 64 o 32 bytes (formato del CLI de Solana, o una semilla)
  [/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g, "[clave-redactada]"],
  [/\[\s*(?:\d{1,3}\s*,\s*){31}\d{1,3}\s*\]/g, "[clave-redactada]"],
  // claves de API y secretos con nombre: "apiKey": "…", x-api-key: …, password=…
  [/((?:x-)?(?:api[-_]?key|apikey|secret(?:[-_]?key)?|private[-_]?key|password|passphrase|jwt|(?:access|auth|api|session|bearer|refresh)[-_]?token)(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?!\{key\}|\[|true\b|false\b|null\b)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redactado]"],
  // JWT (Pinata y similares)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt-redactado]"],
  // credenciales en URL
  [/([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|auth)=)(?!\{key\})[^&\s"'\\]+/gi, "$1[redactado]"],
  // cabeceras de autorización
  [/(authorization["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^"'\s,}\\]+/gi, "$1[redactado]"],
];

/**
 * Una firma de transacción y una clave privada tienen el mismo formato (base58 de 64 bytes): se redacta
 * todo lo que lo tenga salvo las firmas conocidas (`keep`, las de la tabla tx), que son útiles para depurar.
 */
export function redact(text: string, extra: string[] = [], keep: Set<string> = new Set()) {
  let out = scrub(text);
  for (const s of extra) if (s && s.length >= 6) out = out.split(s).join("[redactado]");
  // URLs con la clave en un parámetro con otro nombre, en un segmento o en el subdominio: la misma heurística
  // que al guardar el RPC (aquí separar de más es inocuo)
  out = out.replace(URL_RE, (u) => {
    const { key } = splitRpcKey(u);
    return key && !keep.has(key) ? u.split(key).join("[redactado]") : u;
  });
  out = out.replace(B58_64, (m) => (keep.has(m) ? m : "[clave-redactada]"));
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  out = out.replace(B58_32, (m) => (keep.has(m) ? m : `${m.slice(0, 4)}…${m.slice(-4)}`));
  return out;
}

/** Direcciones públicas que la app conoce: se dejan enteras porque sirven para depurar. */
function knownAddresses(db: ReturnType<Ctx["db"]>) {
  const col = (sql: string) => (db.prepare(sql).all() as { a: string | null }[]).map((r) => r.a).filter((a): a is string => !!a);
  return [
    ...PROGRAMS,
    ...col("SELECT address AS a FROM wallet"),
    ...col("SELECT address AS a FROM mint_key"),
    ...col("SELECT address AS a FROM address_book"),
    ...col("SELECT mint AS a FROM launch"),
    ...col("SELECT DISTINCT mint AS a FROM tx"),
    ...col("SELECT mint AS a FROM live_mint"),
    ...col("SELECT migrated_pool AS a FROM live_mint"),
    ...col("SELECT DISTINCT user AS a FROM live_trade"),
    ...col("SELECT DISTINCT mint AS a FROM trade_order"),
    ...col("SELECT DISTINCT mint AS a FROM task"),
    ...col("SELECT DISTINCT address AS a FROM claim_item"),
  ];
}

function tail(file: string, bytes: number) {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

export function diagnostics(ctx: Ctx) {
  const db = ctx.db();
  // Los secretos se descifran solo para poder buscarlos y quitarlos del archivo
  for (const n of SECRET_NAMES) remember(readSecret(db, ctx.vault, n));
  const count = (sql: string) => db.prepare(sql).all() as { k: string; n: number }[];
  const s = storedSettings(db);
  const report = {
    kind: "nebula-diagnostico",
    generatedAt: new Date().toISOString(),
    profile: ctx.profile,
    runtime: { node: nodeVersion, platform: process.platform, arch: process.arch, uptimeSec: Math.round(process.uptime()) },
    schemaVersion: db.pragma("user_version", { simple: true }),
    chain: ctx.chain.state(),
    // Ajustes sin secretos: las URL del RPC llevan {key} en lugar de la credencial
    settings: { ...s, autoLockMin: ctx.vault.autoLockMin(), secretsSet: Object.fromEntries(SECRET_NAMES.map((n) => [n, !!db.prepare("SELECT 1 FROM setting_secret WHERE name = ?").get(n)])) },
    counts: {
      wallets: count("SELECT kind || CASE archived WHEN 1 THEN ':archivada' ELSE '' END AS k, COUNT(*) AS n FROM wallet GROUP BY k"),
      launches: count("SELECT status AS k, COUNT(*) AS n FROM launch GROUP BY status"),
      drafts: count("SELECT 'borradores' AS k, COUNT(*) AS n FROM launch_draft"),
      tasks: count("SELECT type || ':' || status AS k, COUNT(*) AS n FROM task GROUP BY k"),
      orders: count("SELECT status AS k, COUNT(*) AS n FROM trade_order GROUP BY status"),
      operations: count("SELECT kind || ':' || status AS k, COUNT(*) AS n FROM operation GROUP BY k"),
      tx: count("SELECT kind || ':' || status AS k, COUNT(*) AS n FROM tx GROUP BY k"),
    },
    recentErrors: db.prepare("SELECT kind, error_code AS code, error, updated_at AS at FROM tx WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 30").all(),
    activity: db.prepare("SELECT at, kind, detail FROM activity_log ORDER BY id DESC LIMIT 300").all(),
    log: tail(join(ctx.dataDir, "logs", "nebula.log"), LOG_TAIL_BYTES).split("\n").filter(Boolean),
  };
  const keep = new Set((db.prepare("SELECT signature FROM tx WHERE signature IS NOT NULL").all() as { signature: string }[]).map((r) => r.signature));
  for (const a of knownAddresses(db)) keep.add(a);
  const text = redact(JSON.stringify(report, null, 2), [ctx.token], keep);
  logActivity(db, "diagnostics.export", "Diagnóstico exportado (secretos redactados)");
  return text;
}
