import type { FastifyPluginAsync } from "fastify";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ChangePasswordBody, ConfirmBody, PasswordBody, SetupBody, STEP_UP_HEADER, type VaultStatus } from "@nebula/shared";
import type { Ctx } from "../app";
import { logActivity } from "../db";
import { unwrapDek, VaultError } from "../signer";
import { clearPaused, pausedList } from "../tasks";

export const vaultRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    const { vault } = ctx;

    const status = (): VaultStatus => ({
      profile: ctx.profile,
      initialized: vault.isInitialized(),
      unlocked: vault.isUnlocked(),
      autoLockMin: vault.autoLockMin(),
      lockInSec: vault.lockInSec(),
      retryInSec: vault.retryInSec(),
      paused: vault.isUnlocked() ? pausedList(ctx.db()) : [],
    });

    // Consultar el estado NO cuenta como actividad (no retrasa el bloqueo automático).
    app.get("/status", async () => status());

    app.post("/setup", async (req) => {
      const body = SetupBody.parse(req.body);
      await vault.setup(body.password);
      logActivity(ctx.db(), "vault.setup", "Bóveda creada");
      return status();
    });

    app.post("/unlock", async (req) => {
      const { password } = PasswordBody.parse(req.body);
      await vault.unlock(password);
      logActivity(ctx.db(), "vault.unlock", "Bóveda desbloqueada");
      return status();
    });

    app.post("/lock", async () => {
      vault.lock("manual");
      logActivity(ctx.db(), "vault.lock", "Bloqueo manual");
      return status();
    });

    app.post("/activity", async () => {
      vault.touch();
      return { lockInSec: vault.lockInSec() };
    });

    /** Tras desbloquear: el operador confirma qué reanudar. Aquí solo se descarta la lista; reanudar llega con las tareas. */
    app.post("/paused/ack", async (req) => {
      const { ids } = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
      if (!vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      clearPaused(ctx.db(), ids);
      return status();
    });

    app.post("/confirm", async (req) => {
      const { password, action } = ConfirmBody.parse(req.body);
      vault.touch();
      return vault.issueStepUp(password, action);
    });

    app.post("/change-password", async (req) => {
      vault.consumeStepUp(req.headers[STEP_UP_HEADER] as string | undefined, "change-password");
      const { newPassword } = ChangePasswordBody.parse(req.body);
      await vault.changePassword(newPassword);
      logActivity(ctx.db(), "vault.password", "Contraseña maestra cambiada");
      return { ok: true };
    });

    // REQ-VAULT-005: la copia es la base SQLite (claves cifradas + meta). Inútil sin la contraseña.
    app.get("/backup", async (_req, reply) => {
      if (!vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      vault.touch();
      const dir = join(ctx.dataDir, "tmp");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `backup-${Date.now()}.sqlite`);
      await ctx.db().backup(file);
      const { readFileSync } = await import("node:fs");
      const bytes = readFileSync(file);
      rmSync(file, { force: true });
      logActivity(ctx.db(), "vault.backup", "Copia de seguridad exportada");
      const name = `nebula-${ctx.profile}-${new Date().toISOString().slice(0, 10)}.nebula-vault`;
      return reply.header("content-type", "application/octet-stream").header("content-disposition", `attachment; filename="${name}"`).send(bytes);
    });

    app.post("/restore", { bodyLimit: 64 * 1024 * 1024 }, async (req) => {
      const { fileB64, password } = z.object({ fileB64: z.string().min(16), password: z.string().min(1).max(256) }).parse(req.body);
      if (vault.isUnlocked()) vault.consumeStepUp(req.headers[STEP_UP_HEADER] as string | undefined, "restore");
      const dir = join(ctx.dataDir, "tmp");
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `restore-${Date.now()}.sqlite`);
      writeFileSync(tmp, Buffer.from(fileB64, "base64"));
      let meta: { kdf: string; salt: Buffer; wrapped_dek: Buffer } | undefined;
      let probe: Database.Database | undefined;
      try {
        probe = new Database(tmp, { readonly: true, fileMustExist: true });
        meta = probe.prepare("SELECT kdf, salt, wrapped_dek FROM vault_meta WHERE id = 1").get() as typeof meta;
      } catch {
        meta = undefined;
      } finally {
        probe?.close(); // en Windows no se puede borrar un archivo abierto
      }
      if (!meta) {
        rmSync(tmp, { force: true });
        throw Object.assign(new Error("El archivo no es una copia de Nébula válida."), { statusCode: 400 });
      }
      const dek = meta ? await unwrapDek(meta, password) : null;
      if (!dek) {
        rmSync(tmp, { force: true });
        throw new VaultError("BAD_PASSWORD", "La contraseña no abre esta copia.");
      }
      dek.fill(0);
      // Sustituye la base actual por la copia verificada
      vault.lock("restore");
      ctx.closeDb();
      const target = join(ctx.dataDir, "nebula.sqlite");
      for (const ext of ["-wal", "-shm"]) if (existsSync(target + ext)) rmSync(target + ext, { force: true });
      copyFileSync(tmp, target);
      rmSync(tmp, { force: true });
      ctx.reopenDb();
      await vault.unlock(password);
      logActivity(ctx.db(), "vault.restore", "Bóveda restaurada desde copia");
      return status();
    });
  };
