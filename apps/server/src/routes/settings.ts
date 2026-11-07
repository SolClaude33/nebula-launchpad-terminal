import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { JITO_MIN_TIP_SOL, PutSettingsBody, type ActivityDto, type SettingsDto } from "@nebula/shared";
import type { Ctx } from "../app";
import { kvSet, logActivity } from "../db";
import { VaultError } from "../signer";
import { hasSecret, remember, splitRpcKey, storedSettings, type SecretName } from "../settings";
import { JITO_MIN_TIP_LAMPORTS } from "../chain/jito";
import { solToLamports } from "../chain/types";
import { testIpfsKey } from "../ipfs";
import { diagnostics } from "../diagnostics";

export const settingsRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async (req) => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      if (req.method !== "GET") ctx.vault.touch(); // las lecturas no cuentan como actividad
    });

    const read = (): SettingsDto => {
      const db = ctx.db();
      return { ...storedSettings(db), autoLockMin: ctx.vault.autoLockMin(), ipfsKeySet: hasSecret(db, "ipfsKey"), rpcKeySet: hasSecret(db, "rpcKey"), rpcBackupKeySet: hasSecret(db, "rpcBackupKey") };
    };

    app.get("/settings", async () => read());

    // REQ-SET-002: los secretos van cifrados dentro de la bóveda, nunca a .env ni a texto plano.
    // Una URL de RPC con la credencial dentro se parte: la URL queda con {key} y la credencial va a la bóveda.
    app.put("/settings", async (req) => {
      const body = PutSettingsBody.parse(req.body);
      const db = ctx.db();
      const { ipfsKey, rpcKey, rpcBackupKey, autoLockMin, ...plain } = body;
      const secrets: [SecretName, string | undefined][] = [
        ["ipfsKey", ipfsKey?.trim()],
        ["rpcKey", rpcKey?.trim()],
        ["rpcBackupKey", rpcBackupKey?.trim()],
      ];
      const setSecret = (name: SecretName, v: string | undefined) => secrets.splice(secrets.findIndex((s) => s[0] === name), 1, [name, v]);
      for (const [field, secret] of [
        ["rpcPrimaryHttp", "rpcKey"],
        ["rpcPrimaryWs", "rpcKey"],
        ["rpcBackupHttp", "rpcBackupKey"],
        ["rpcBackupWs", "rpcBackupKey"],
      ] as const) {
        const v = plain[field];
        if (v === undefined) continue;
        const s = splitRpcKey(v);
        plain[field] = s.url;
        if (s.key) {
          const cur = secrets.find((x) => x[0] === secret)![1];
          if (cur && cur !== s.key) throw Object.assign(new Error("La URL lleva una clave distinta de la indicada en el campo de clave."), { statusCode: 400 });
          setSecret(secret, s.key);
        }
      }
      const stored = storedSettings(db);
      // F2 · bloque 5: con Jito activo, la propina tiene que llegar al mínimo que acepta Jito (1.000 lamports)
      const next = { ...stored, ...plain };
      if (next.jitoEnabled && !(solToLamports(next.jitoTipSol) >= JITO_MIN_TIP_LAMPORTS)) throw Object.assign(new Error(`La propina de Jito tiene que ser al menos ${JITO_MIN_TIP_SOL.toLocaleString("es-ES", { maximumFractionDigits: 9 })} SOL (1.000 lamports).`), { statusCode: 400 });
      kvSet(db, "settings", JSON.stringify(next));
      if (autoLockMin !== undefined) kvSet(db, "autoLockMin", String(autoLockMin));
      const changedSecrets: string[] = [];
      for (const [name, value] of secrets) {
        if (value === undefined) continue;
        changedSecrets.push(name);
        if (value === "") db.prepare("DELETE FROM setting_secret WHERE name = ?").run(name);
        else {
          remember(value);
          db.prepare("INSERT INTO setting_secret(name, ciphertext) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext").run(name, ctx.vault.sealSecret(name, value));
        }
      }
      if (Object.keys(plain).some((k) => k.startsWith("rpc") || k === "priorityFeeSol") || changedSecrets.some((n) => n.startsWith("rpc"))) {
        ctx.live.stopAll();
        ctx.chain.reload();
      }
      // REQ-LOG-001: se registran los nombres de lo que cambió, nunca los valores de los secretos
      const names = [...Object.keys(plain), ...(autoLockMin !== undefined ? ["autoLockMin"] : []), ...changedSecrets.map((n) => `${n} (secreto)`)];
      logActivity(db, "settings.update", `Ajustes cambiados: ${names.join(", ")}`);
      return read();
    });

    // Comprueba la clave de Pinata guardada (o una nueva sin guardarla) contra su endpoint de autenticación
    app.post("/settings/ipfs/test", async (req) => {
      const { key } = z.object({ key: z.string().max(2000).optional() }).parse(req.body ?? {});
      return testIpfsKey(ctx, key?.trim() || undefined);
    });

    // REQ-LOG-001: diagnóstico con los secretos redactados (se descarga como JSON)
    app.get("/diagnostics", async (_req, reply) => {
      const name = `nebula-diagnostico-${ctx.profile}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      return reply.header("content-type", "application/json; charset=utf-8").header("content-disposition", `attachment; filename="${name}"`).send(diagnostics(ctx));
    });

    // §7.3: copias automáticas diarias (las últimas 7), copia manual y descarga para restaurar desde /unlock
    app.get("/backups", async () => ({ items: ctx.backups.list(), keep: 7 }));
    app.post("/backups/run", async () => ({ made: await ctx.backups.run(true), items: ctx.backups.list() }));
    app.get("/backups/:name", async (req, reply) => {
      const { name } = z.object({ name: z.string().max(80) }).parse(req.params);
      const { readFileSync } = await import("node:fs");
      const bytes = readFileSync(ctx.backups.pathOf(name));
      logActivity(ctx.db(), "vault.backup", `Copia automática ${name} descargada`);
      return reply.header("content-type", "application/octet-stream").header("content-disposition", `attachment; filename="nebula-${ctx.profile}-${name}"`).send(bytes);
    });

    // REQ-LOG-001: registro de actividad local, paginado
    app.get("/activity", async (req) => {
      const { before, limit, kind } = z.object({ before: z.coerce.number().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), kind: z.string().max(40).optional() }).parse(req.query);
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (before) where.push("id < ?"), args.push(before);
      if (kind) where.push("(kind = ? OR kind LIKE ?)"), args.push(kind, `${kind}.%`);
      const rows = ctx.db().prepare(`SELECT id, at, kind, detail FROM activity_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit) as ActivityDto[];
      return { items: rows };
    });
  };
