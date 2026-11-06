import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { PutSettingsBody, type ActivityDto, type SettingsDto } from "@nebula/shared";
import type { Ctx } from "../app";
import { kvGet, kvSet, logActivity } from "../db";
import { VaultError } from "../signer";

const DEFAULTS: Omit<SettingsDto, "ipfsKeySet" | "rpcKeySet" | "autoLockMin"> = {
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
};

export const settingsRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async () => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      ctx.vault.touch();
    });

    const read = (): SettingsDto => {
      const db = ctx.db();
      const stored = JSON.parse(kvGet(db, "settings") ?? "{}");
      const has = (n: string) => !!db.prepare("SELECT 1 FROM setting_secret WHERE name = ?").get(n);
      return { ...DEFAULTS, ...stored, autoLockMin: ctx.vault.autoLockMin(), ipfsKeySet: has("ipfsKey"), rpcKeySet: has("rpcKey") };
    };

    app.get("/settings", async () => read());

    // REQ-SET-002: los secretos van cifrados dentro de la bóveda, nunca a .env ni a texto plano
    app.put("/settings", async (req) => {
      const body = PutSettingsBody.parse(req.body);
      const db = ctx.db();
      const { ipfsKey, rpcKey, autoLockMin, ...plain } = body;
      const stored = JSON.parse(kvGet(db, "settings") ?? "{}");
      kvSet(db, "settings", JSON.stringify({ ...stored, ...plain }));
      if (autoLockMin !== undefined) kvSet(db, "autoLockMin", String(autoLockMin));
      for (const [name, value] of [["ipfsKey", ipfsKey], ["rpcKey", rpcKey]] as const) {
        if (value === undefined) continue;
        if (value === "") db.prepare("DELETE FROM setting_secret WHERE name = ?").run(name);
        else db.prepare("INSERT INTO setting_secret(name, ciphertext) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext").run(name, ctx.vault.sealSecret(name, value));
      }
      logActivity(db, "settings.update", `Ajustes cambiados: ${Object.keys(body).join(", ")}`);
      return read();
    });

    // REQ-LOG-001: registro de actividad local, paginado
    app.get("/activity", async (req) => {
      const { before, limit } = z.object({ before: z.coerce.number().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      const rows = ctx.db().prepare(`SELECT id, at, kind, detail FROM activity_log ${before ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`).all(...(before ? [before, limit] : [limit])) as ActivityDto[];
      return { items: rows };
    });
  };
