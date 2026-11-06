// REQ-LOG-001 / NFR-SEC-004: «Exportar diagnóstico». Junta el estado de la app, la actividad reciente y la
// cola del log técnico en un JSON y lo redacta antes de que salga del proceso:
// - por valor: los secretos de Ajustes (descifrados solo para buscarlos), el token de sesión y cualquier
//   secreto registrado en `remember`;
// - por patrón: claves privadas (base58 de 64 bytes, arrays JSON de 64 números), JWT, parámetros de
//   credencial en URL y cabeceras de autorización.
// Nunca incluye claves de wallets (no se descifran aquí) ni el contenido de la bóveda.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { version as nodeVersion } from "node:process";
import type { Ctx } from "./app";
import { logActivity } from "./db";
import { readSecret, remember, scrub, SECRET_NAMES, storedSettings } from "./settings";

const LOG_TAIL_BYTES = 512 * 1024;

// claves privadas de Solana en base58 (64 bytes ≈ 86-88 caracteres)
const B58_64 = /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g;
const PATTERNS: [RegExp, string][] = [
  // arrays de 64 bytes (formato del CLI de Solana)
  [/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g, "[clave-redactada]"],
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
  out = out.replace(B58_64, (m) => (keep.has(m) ? m : "[clave-redactada]"));
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
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
  const sigs = new Set((db.prepare("SELECT signature FROM tx WHERE signature IS NOT NULL").all() as { signature: string }[]).map((r) => r.signature));
  const text = redact(JSON.stringify(report, null, 2), [ctx.token], sigs);
  logActivity(db, "diagnostics.export", "Diagnóstico exportado (secretos redactados)");
  return text;
}
