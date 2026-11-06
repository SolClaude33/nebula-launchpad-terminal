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
