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

    app.post("/launches/alt", async (req) => {
      const { payerWalletId } = z.object({ payerWalletId: z.string() }).parse(req.body);
      return ctx.launches.ensureAlt(payerWalletId);
    });

    app.post("/launches/:id/execute", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.launches.execute(id);
    });

    app.post("/launches/:id/resume", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.launches.resume(id);
    });

    app.get("/launches", async () => ({ items: ctx.launches.list() }));

    app.get("/launches/:id", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.launches.view(id);
    });
  };
