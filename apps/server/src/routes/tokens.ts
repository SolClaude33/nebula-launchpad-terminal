import type { FastifyPluginAsync } from "fastify";
import { STEP_UP_HEADER } from "@nebula/shared";
import type { Ctx } from "../app";
import { VaultError } from "../signer";
import { BurnInput, SendInput } from "../token-ops";

// REQ-LIVE-005: enviar tokens y quemar supply desde el Live Workspace
export const tokenRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async (req) => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      if (req.method !== "GET") ctx.vault.touch();
    });
    app.post("/tokens/send/preview", async (req) => ctx.tokenOps.preview("send", SendInput.parse(req.body)));
    app.post("/tokens/send", async (req) => ctx.tokenOps.execute("send", SendInput.parse(req.body), req.headers[STEP_UP_HEADER] as string | undefined));
    app.post("/tokens/burn/preview", async (req) => ctx.tokenOps.preview("burn", BurnInput.parse(req.body)));
    app.post("/tokens/burn", async (req) => ctx.tokenOps.execute("burn", BurnInput.parse(req.body)));
  };
