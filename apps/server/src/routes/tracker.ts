import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app";
import { VaultError } from "../signer";
import { isValidAddress } from "../chain/transfers";

const Mint = z.string().refine((v) => isValidAddress(v) || /^[\w-]{8,64}$/.test(v), "Dirección de token no válida");

// REQ-LIVE-006: tracker (lista de seguimiento de tokens)
export const trackerRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async (req) => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      if (req.method !== "GET") ctx.vault.touch();
    });
    // ?lite=1: sin leer la cadena (paleta de comandos, estrella del Live)
    app.get("/tracker", async (req) => {
      const { lite } = z.object({ lite: z.coerce.number().optional() }).parse(req.query);
      return { items: lite ? ctx.tracker.lite() : await ctx.tracker.list() };
    });
    app.post("/tracker", async (req) => ctx.tracker.add(z.object({ mint: Mint }).parse(req.body).mint));
    app.delete("/tracker/:mint", async (req) => ctx.tracker.remove(z.object({ mint: Mint }).parse(req.params).mint));
  };
