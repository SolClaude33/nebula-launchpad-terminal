import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app";
import { VaultError } from "../signer";
import { MainnetIpfsUnavailable } from "../ipfs";

export const launchRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async (req) => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      if (req.method !== "GET") ctx.vault.touch();
    });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof MainnetIpfsUnavailable) return reply.code(409).send({ code: "IPFS_UNAVAILABLE", message: err.message });
      throw err;
    });

    // REQ-LAUNCH-002: el archivo va del navegador a la API local; la clave de IPFS nunca sale de la bóveda.
    // 10 MB de vídeo ≈ 13,4 MB en base64: el límite se sube solo aquí.
    app.post("/launches/media", { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
      const { fileB64, contentType } = z.object({ fileB64: z.string().min(4), contentType: z.string() }).parse(req.body);
      return ctx.launches.uploadMedia(Buffer.from(fileB64, "base64"), contentType);
    });

    // REQ-LAUNCH-011: estimaciones del resumen calculadas por el adaptador
    app.post("/launches/quote", async (req) => {
      const { devBuyLamports, buys } = z.object({ devBuyLamports: z.string().regex(/^\d+$/), buys: z.array(z.string().regex(/^\d+$/)).max(40) }).parse(req.body);
      const q = await ctx.launches.quote(BigInt(devBuyLamports), buys.map(BigInt));
      return { devTokens: q.devTokens.toString(), buyTokens: q.buyTokens.map(String), supply: q.supply.toString(), marketCapLamports: q.marketCapLamports.toString(), graduationPct: q.graduationPct, padFeeBps: q.padFeeBps };
    });

    app.post("/launches/preflight", async (req) => ctx.launches.preflight(req.body));

    // REQ-LAUNCH-005: clonar metadatos de un token (solo rellena el formulario)
    app.post("/launches/clone", async (req) => {
      const { mint } = z.object({ mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Dirección de token no válida") }).parse(req.body);
      return ctx.cloner.clone(mint);
    });

    app.post("/launches/alt", async (req) => {
      const { payerWalletId } = z.object({ payerWalletId: z.string() }).parse(req.body);
      return ctx.launches.ensureAlt(payerWalletId);
    });
    // REQ-LAUNCH-006: mint vanity del borrador (generar en local con hilos aparte, o importar la clave)
    const Draft = z.object({ draftId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/) });
    app.get("/launches/:draftId/vanity", async (req) => ctx.vanity.status(Draft.parse(req.params).draftId));
    app.post("/launches/:draftId/vanity/generate", async (req) => {
      const b = z.object({ prefix: z.string().max(8).default(""), suffix: z.string().max(8).default(""), ci: z.boolean().default(false) }).parse(req.body);
      return ctx.vanity.start(Draft.parse(req.params).draftId, b);
    });
    app.post("/launches/:draftId/vanity/cancel", async (req) => ctx.vanity.cancel(Draft.parse(req.params).draftId));
    app.post("/launches/:draftId/vanity/import", async (req) => ctx.vanity.importKey(Draft.parse(req.params).draftId, z.object({ secret: z.string().min(32).max(1024) }).parse(req.body).secret));
    app.post("/launches/:draftId/vanity/clear", async (req) => ctx.vanity.unbind(Draft.parse(req.params).draftId));

    // Recuperar el rent de la tabla de direcciones: desactivar y, ~512 slots después, cerrar
    app.get("/launches/alt", async () => ctx.launches.altInfo());
    app.post("/launches/alt/deactivate", async () => ctx.launches.deactivateAlt());
    app.post("/launches/alt/close", async (req) => ctx.launches.closeAlt(z.object({ recipientId: z.string() }).parse(req.body).recipientId));

    app.post("/launches/:id/execute", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.launches.execute(id);
    });

    // REQ-LAUNCH-015: programar y cancelar (hasta T−10 s)
    app.post("/launches/:id/schedule", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { at } = z.object({ at: z.number().int() }).parse(req.body);
      return ctx.launches.schedule(id, at);
    });
    app.post("/launches/:id/schedule/cancel", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.launches.cancelSchedule(id);
    });

    app.post("/launches/:id/resume", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.launches.resume(id);
    });

    app.get("/launches", async (req) => {
      const q = z.object({ all: z.enum(["0", "1"]).default("0"), archived: z.enum(["0", "1"]).default("0") }).parse(req.query);
      return { items: q.all === "1" ? ctx.launches.listAll(q.archived === "1") : ctx.launches.list() };
    });

    // REQ-LAUNCH-020: archivar o recuperar un lanzamiento (solo cambia la lista; nada en cadena)
    app.post("/launches/:id/archive", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
      return ctx.launches.archive(id, archived);
    });

    // REQ-LAUNCH-004: borradores en el servidor
    app.get("/drafts", async () => ({ items: ctx.drafts.list() }));
    app.get("/drafts/latest", async () => ({ draft: ctx.drafts.latest() }));
    app.get("/drafts/:id", async (req) => ctx.drafts.get(z.object({ id: z.string() }).parse(req.params).id));
    app.put("/drafts/:id", { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const data = z.record(z.string(), z.unknown()).parse(req.body);
      return ctx.drafts.save(id, data);
    });
    app.delete("/drafts/:id", async (req) => ctx.drafts.remove(z.object({ id: z.string() }).parse(req.params).id));

    app.get("/launches/:id", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.launches.view(id);
    });
  };
