import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CreateWalletsBody,
  ExportBody,
  FolderBody,
  FolderMembersBody,
  ImportWalletsBody,
  PatchWalletsBody,
  STEP_UP_HEADER,
  type FolderDto,
  type ImportRow,
  type WalletDto,
} from "@nebula/shared";
import type { Ctx } from "../app";
import { logActivity, type DB } from "../db";
import { parseSecret, VaultError } from "../signer";

type Row = { id: string; label: string; address: string; kind: "wallet" | "funder"; role: string | null; archived: number; is_default_funder: number; created_at: number };

function listWallets(db: DB, includeArchived: boolean): WalletDto[] {
  const rows = db.prepare(`SELECT id, label, address, kind, role, archived, is_default_funder, created_at FROM wallet ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY kind, created_at, label`).all() as Row[];
  const links = db.prepare("SELECT wallet_id, folder_id FROM wallet_folder").all() as { wallet_id: string; folder_id: string }[];
  const byWallet = new Map<string, string[]>();
  for (const l of links) byWallet.set(l.wallet_id, [...(byWallet.get(l.wallet_id) ?? []), l.folder_id]);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    address: r.address,
    kind: r.kind,
    role: r.role,
    archived: !!r.archived,
    isDefaultFunder: !!r.is_default_funder,
    folderIds: byWallet.get(r.id) ?? [],
    createdAt: r.created_at,
  }));
}

function nextIndex(db: DB, prefix: string) {
  const rows = db.prepare("SELECT label FROM wallet WHERE label LIKE ?").all(`${prefix} %`) as { label: string }[];
  return rows.reduce((m, r) => Math.max(m, Number(r.label.slice(prefix.length + 1)) || 0), 0) + 1;
}

function ensureDefaultFunder(db: DB) {
  const has = db.prepare("SELECT 1 FROM wallet WHERE kind = 'funder' AND is_default_funder = 1 AND archived = 0").get();
  if (!has) {
    const first = db.prepare("SELECT id FROM wallet WHERE kind = 'funder' AND archived = 0 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    if (first) db.prepare("UPDATE wallet SET is_default_funder = 1 WHERE id = ?").run(first.id);
  }
}

export const walletRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    const { vault } = ctx;
    // Todo lo de wallets exige la bóveda abierta. Solo las acciones cuentan como actividad:
    // las lecturas periódicas (sondeos de la interfaz) no deben retrasar el bloqueo automático.
    app.addHook("preHandler", async (req) => {
      if (!vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      if (req.method !== "GET") vault.touch();
    });

    app.get("/wallets", async (req) => {
      const { archived } = z.object({ archived: z.enum(["0", "1"]).optional() }).parse(req.query);
      return { wallets: listWallets(ctx.db(), archived === "1") };
    });

    // REQ-WAL-001: crear de 1 a 100 wallets por operación
    app.post("/wallets", async (req) => {
      const body = CreateWalletsBody.parse(req.body);
      const db = ctx.db();
      const prefix = body.labelPrefix?.trim() || (body.kind === "funder" ? "Funder" : "Wallet");
      const start = nextIndex(db, prefix);
      const created: string[] = [];
      const keys = await Promise.all(Array.from({ length: body.count }, () => vault.generateKey()));
      const ins = db.prepare("INSERT INTO wallet(id, label, address, kind, role, encrypted_key, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)");
      const link = db.prepare("INSERT OR IGNORE INTO wallet_folder(wallet_id, folder_id) VALUES(?, ?)");
      db.transaction(() => {
        keys.forEach((k, i) => {
          const id = randomUUID();
          ins.run(id, `${prefix} ${String(start + i).padStart(2, "0")}`, k.address, body.kind, body.role ?? null, vault.sealKey(id, k.sk), Date.now() + i);
          if (body.folderId) link.run(id, body.folderId);
          created.push(id);
        });
        if (body.kind === "funder") ensureDefaultFunder(db);
      })();
      logActivity(db, "wallets.create", `${body.count} ${body.kind === "funder" ? "funders" : "wallets"} creadas`);
      return { created, wallets: listWallets(db, false) };
    });

    // REQ-WAL-002: importación en bloque; duplicados detectados, inválidas marcadas por fila sin abortar
    app.post("/wallets/import", async (req) => {
      const body = ImportWalletsBody.parse(req.body);
      const db = ctx.db();
      const existing = new Set((db.prepare("SELECT address FROM wallet").all() as { address: string }[]).map((r) => r.address));
      const rows: ImportRow[] = [];
      const prefix = body.kind === "funder" ? "Funder" : "Importada";
      let n = nextIndex(db, prefix);
      const ins = db.prepare("INSERT INTO wallet(id, label, address, kind, role, encrypted_key, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)");
      const link = db.prepare("INSERT OR IGNORE INTO wallet_folder(wallet_id, folder_id) VALUES(?, ?)");
      const lines = body.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i].trim();
        if (!raw || raw.startsWith("#")) continue;
        const parsed = await parseSecret(raw);
        if ("error" in parsed) {
          rows.push({ line: i + 1, status: "invalid", reason: parsed.error });
          continue;
        }
        if (existing.has(parsed.address)) {
          parsed.sk.fill(0);
          rows.push({ line: i + 1, status: "duplicate", address: parsed.address, reason: "Ya existe" });
          continue;
        }
        const id = randomUUID();
        ins.run(id, `${prefix} ${String(n++).padStart(2, "0")}`, parsed.address, body.kind, body.role ?? null, vault.sealKey(id, parsed.sk), Date.now() + i);
        if (body.folderId) link.run(id, body.folderId);
        existing.add(parsed.address);
        rows.push({ line: i + 1, status: "imported", address: parsed.address });
      }
      if (body.kind === "funder") ensureDefaultFunder(db);
      const ok = rows.filter((r) => r.status === "imported").length;
      logActivity(db, "wallets.import", `${ok} importadas · ${rows.length - ok} con incidencias`);
      return { rows, wallets: listWallets(db, false) };
    });

    // REQ-WAL-004 / 007: rol (asignado a mano, nunca cambia solo), archivar/restaurar, renombrar
    app.patch("/wallets", async (req) => {
      const body = PatchWalletsBody.parse(req.body);
      const db = ctx.db();
      db.transaction(() => {
        for (const id of body.ids) {
          if (body.role !== undefined) db.prepare("UPDATE wallet SET role = ? WHERE id = ?").run(body.role, id);
          if (body.archived !== undefined) {
            const w = db.prepare("SELECT is_default_funder FROM wallet WHERE id = ?").get(id) as { is_default_funder: number } | undefined;
            if (body.archived && w?.is_default_funder) throw Object.assign(new Error("No se puede archivar el funder predeterminado."), { statusCode: 409 });
            db.prepare("UPDATE wallet SET archived = ? WHERE id = ?").run(body.archived ? 1 : 0, id);
          }
          if (body.label !== undefined && body.ids.length === 1) db.prepare("UPDATE wallet SET label = ? WHERE id = ?").run(body.label, id);
        }
      })();
      return { wallets: listWallets(db, true) };
    });

    // REQ-WAL-006: exportar exige reconfirmar la contraseña; queda en el registro de actividad (sin la clave)
    app.post("/wallets/export", async (req) => {
      vault.consumeStepUp(req.headers[STEP_UP_HEADER] as string | undefined, "export-keys");
      const { ids } = ExportBody.parse(req.body);
      const db = ctx.db();
      const get = db.prepare("SELECT id, label, address, encrypted_key FROM wallet WHERE id = ?");
      const keys = ids.map((id) => {
        const r = get.get(id) as { id: string; label: string; address: string; encrypted_key: Buffer } | undefined;
        if (!r) throw Object.assign(new Error("Wallet no encontrada"), { statusCode: 404 });
        return { id: r.id, label: r.label, address: r.address, secretKey: vault.revealKey(r.id, r.encrypted_key) };
      });
      logActivity(db, "wallets.export", `Exportadas ${keys.length} claves: ${keys.map((k) => k.address.slice(0, 4) + "…" + k.address.slice(-4)).join(", ")}`);
      return { keys };
    });

    // REQ-WAL-007 / REQ-FUND-004: borrar exige reconfirmación (sin RPC no se puede descartar saldo); nunca el funder predeterminado
    app.delete("/wallets", async (req) => {
      vault.consumeStepUp(req.headers[STEP_UP_HEADER] as string | undefined, "delete-wallet");
      const { ids } = ExportBody.parse(req.body);
      const db = ctx.db();
      const defaults = db.prepare(`SELECT id FROM wallet WHERE is_default_funder = 1 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids);
      if (defaults.length) throw Object.assign(new Error("No se puede borrar el funder predeterminado. Elige otro predeterminado antes."), { statusCode: 409 });
      const busy = db.prepare("SELECT config FROM task WHERE status IN ('RUNNING','PAUSED','IDLE')").all() as { config: string }[];
      if (busy.some((t) => ids.some((id) => t.config.includes(id)))) throw Object.assign(new Error("Hay wallets usadas por una tarea activa."), { statusCode: 409 });
      db.prepare(`DELETE FROM wallet WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
      logActivity(db, "wallets.delete", `${ids.length} wallets borradas`);
      return { wallets: listWallets(db, true) };
    });

    // REQ-FUND-001: siempre hay un funder predeterminado
    app.post("/funders/default", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.body);
      const db = ctx.db();
      const w = db.prepare("SELECT kind, archived FROM wallet WHERE id = ?").get(id) as { kind: string; archived: number } | undefined;
      if (!w || w.kind !== "funder" || w.archived) throw Object.assign(new Error("No es un funder activo."), { statusCode: 400 });
      db.transaction(() => {
        db.prepare("UPDATE wallet SET is_default_funder = 0 WHERE kind = 'funder'").run();
        db.prepare("UPDATE wallet SET is_default_funder = 1 WHERE id = ?").run(id);
      })();
      return { wallets: listWallets(db, false) };
    });

    // ── Carpetas (REQ-WAL-003): una wallet puede estar en varias ──
    const folders = (): FolderDto[] => (ctx.db().prepare("SELECT id, name, created_at AS createdAt FROM folder ORDER BY created_at").all() as FolderDto[]);
    app.get("/folders", async () => ({ folders: folders() }));
    app.post("/folders", async (req) => {
      const { name } = FolderBody.parse(req.body);
      try {
        ctx.db().prepare("INSERT INTO folder(id, name, created_at) VALUES(?, ?, ?)").run(randomUUID(), name, Date.now());
      } catch {
        throw Object.assign(new Error("Ya existe una carpeta con ese nombre."), { statusCode: 409 });
      }
      return { folders: folders() };
    });
    app.patch("/folders/:id", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { name } = FolderBody.parse(req.body);
      ctx.db().prepare("UPDATE folder SET name = ? WHERE id = ?").run(name, id);
      return { folders: folders() };
    });
    app.delete("/folders/:id", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      ctx.db().prepare("DELETE FROM folder WHERE id = ?").run(id);
      return { folders: folders(), wallets: listWallets(ctx.db(), false) };
    });
    app.post("/folders/:id/members", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { walletIds, op } = FolderMembersBody.parse(req.body);
      const db = ctx.db();
      const stmt = op === "add" ? db.prepare("INSERT OR IGNORE INTO wallet_folder(wallet_id, folder_id) VALUES(?, ?)") : db.prepare("DELETE FROM wallet_folder WHERE wallet_id = ? AND folder_id = ?");
      db.transaction(() => walletIds.forEach((w) => stmt.run(w, id)))();
      return { wallets: listWallets(db, false) };
    });
  };
