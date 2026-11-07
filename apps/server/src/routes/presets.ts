import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app";
import { VaultError } from "../signer";
import { PresetKind } from "../presets";

// REQ-LAUNCH-018 / REQ-AUTO-009: presets de lanzamiento y de tareas
export const presetRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async (req) => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      if (req.method !== "GET") ctx.vault.touch();
    });
    app.get("/presets", async (req) => ({ items: ctx.presets.list(z.object({ kind: PresetKind }).parse(req.query).kind) }));
    app.put("/presets/:id", { bodyLimit: 128 * 1024 }, async (req) => ctx.presets.save(z.object({ id: z.string() }).parse(req.params).id, req.body));
    app.delete("/presets/:id", async (req) => ctx.presets.remove(z.object({ id: z.string() }).parse(req.params).id));
  };
