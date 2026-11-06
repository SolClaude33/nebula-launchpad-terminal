import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE vault_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    kdf TEXT NOT NULL,            -- JSON {alg, opslimit, memlimit}
    salt BLOB NOT NULL,
    wrapped_dek BLOB NOT NULL,    -- nonce(12) | ciphertext | tag(16)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE wallet (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    address TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('wallet','funder')),
    role TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    is_default_funder INTEGER NOT NULL DEFAULT 0,
    encrypted_key BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE folder (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
  CREATE TABLE wallet_folder (
    wallet_id TEXT NOT NULL REFERENCES wallet(id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL REFERENCES folder(id) ON DELETE CASCADE,
    PRIMARY KEY (wallet_id, folder_id)
  );
  CREATE TABLE setting_secret (name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
  CREATE TABLE task (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL,
    config TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  `,
  `
  -- Claves de mint (REQ-LAUNCH-006): se generan y sellan antes de enviar la creación
  CREATE TABLE mint_key (id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE, encrypted_key BLOB NOT NULL, created_at INTEGER NOT NULL);
  -- NFR-TX-001/004/005: cada envío se registra ANTES de emitirse, con su idempotency key
  CREATE TABLE tx (
    idempotency_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    signature TEXT,
    last_valid_block_height INTEGER,
    status TEXT NOT NULL CHECK (status IN ('SENT','CONFIRMED','FAILED','EXPIRED')),
    error_code TEXT,
    error TEXT,
    fee_lamports INTEGER,
    payer TEXT NOT NULL,
    mint TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tx_status ON tx(status);
  `,
  `
  -- REQ-WAL-008: movimientos de fondos como operaciones del servidor (siguen aunque se cierre el modal)
  CREATE TABLE operation (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('transfer','withdraw','disperse','collect')),
    status TEXT NOT NULL CHECK (status IN ('PREVIEW','RUNNING','PAUSED','COMPLETED','PARTIAL','FAILED')),
    plan TEXT NOT NULL,
    fee_total INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE operation_item (
    op_id TEXT NOT NULL REFERENCES operation(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    chunk INTEGER NOT NULL,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    lamports INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING','OK','FAILED','SKIPPED')),
    signature TEXT,
    reason TEXT,
    PRIMARY KEY (op_id, idx)
  );
  -- REQ-FUND-003: direcciones externas guardadas
  CREATE TABLE address_book (address TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL);
  `,
  `
  -- REQ-LAUNCH-016: un lanzamiento por borrador (draftId), con su máquina de estados persistida
  CREATE TABLE launch (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('PREPARED','CREATING','CREATED','BUYING','DONE','FAILED','PAUSED')),
    paused_from TEXT,
    config TEXT NOT NULL,
    preflight_fp TEXT,
    mint TEXT NOT NULL,
    create_sig TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE launch_buy (
    launch_id TEXT NOT NULL REFERENCES launch(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    wallet_id TEXT NOT NULL,
    lamports INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING','OK','FAILED','SKIPPED')),
    tokens TEXT,
    signature TEXT,
    reason TEXT,
    PRIMARY KEY (launch_id, ord)
  );
  -- Metadatos y medios en el almacén local del perfil de pruebas (direccionados por hash)
  CREATE TABLE ipfs_local (cid TEXT PRIMARY KEY, content_type TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);
  `,
  `
  -- REQ-LIVE-001: trades indexados por mint (WS de logs + sondeo de firmas). Un evento por (firma, índice).
  CREATE TABLE live_trade (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    signature TEXT NOT NULL,
    idx INTEGER NOT NULL,
    venue TEXT NOT NULL CHECK (venue IN ('curve','pumpswap')),
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    lamports TEXT NOT NULL,
    tokens TEXT NOT NULL,
    user TEXT NOT NULL,
    ts INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    mc TEXT NOT NULL,
    UNIQUE (mint, signature, idx)
  );
  CREATE INDEX live_trade_mint ON live_trade(mint, seq);
  CREATE INDEX live_trade_user ON live_trade(mint, user);
  -- firmas ya procesadas (con o sin eventos) para no volver a pedirlas
  CREATE TABLE live_sig (mint TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY (mint, signature));
  CREATE TABLE live_mint (mint TEXT PRIMARY KEY, newest TEXT, backfilled INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, migrated_pool TEXT, updated_at INTEGER NOT NULL);
  -- REQ-LIVE-002/003: órdenes multi-wallet del ticket y del Instant Trade, con resultado por wallet
  CREATE TABLE trade_order (
    id TEXT PRIMARY KEY,
    mint TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    status TEXT NOT NULL CHECK (status IN ('RUNNING','PAUSED','COMPLETED','PARTIAL','FAILED')),
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE trade_order_item (
    order_id TEXT NOT NULL REFERENCES trade_order(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    wallet_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING','OK','FAILED','SKIPPED')),
    amount TEXT,
    result TEXT,
    signature TEXT,
    reason TEXT,
    PRIMARY KEY (order_id, ord)
  );
  -- REQ-REW-001/002: reclamos de comisiones de creador con confirmación y verificación en cadena
  CREATE TABLE claim (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('PREVIEW','RUNNING','PAUSED','COMPLETED','PARTIAL','FAILED')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE claim_item (
    claim_id TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    wallet_id TEXT NOT NULL,
    address TEXT NOT NULL,
    expected TEXT NOT NULL,
    -- coste total simulado (fee de red + cuentas nuevas que crea el reclamo) y solo la fee de red
    fee TEXT NOT NULL,
    network_fee TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PENDING','OK','FAILED','SKIPPED')),
    received TEXT,
    left_after TEXT,
    signature TEXT,
    reason TEXT,
    PRIMARY KEY (claim_id, ord)
  );
  `,
  `
  -- REQ-AUTO-001…010: automatizaciones sobre la tabla task (estado de ejecución en JSON) y una fila por
  -- ejecución que apunta a su orden hija (trade_order con id auto-<tarea>-<generación>-<n>)
  ALTER TABLE task ADD COLUMN mint TEXT;
  ALTER TABLE task ADD COLUMN state TEXT NOT NULL DEFAULT '{}';
  CREATE INDEX task_mint ON task(mint, status);
  CREATE TABLE task_run (
    task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    order_id TEXT NOT NULL,
    target INTEGER,
    mc_usd REAL,
    at INTEGER NOT NULL,
    PRIMARY KEY (task_id, generation, seq)
  );
  -- REQ-AUTO-007: reintentos por wallet (pasos tras el primero)
  ALTER TABLE trade_order_item ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  `,
];

export function openDb(dir: string): DB {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "nebula.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

export function migrate(db: DB) {
  const v = db.pragma("user_version", { simple: true }) as number;
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export const kvGet = (db: DB, key: string) => (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
export const kvSet = (db: DB, key: string, value: string) => db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);

export function logActivity(db: DB, kind: string, detail: string) {
  db.prepare("INSERT INTO activity_log(at, kind, detail) VALUES(?, ?, ?)").run(Date.now(), kind, detail);
}
