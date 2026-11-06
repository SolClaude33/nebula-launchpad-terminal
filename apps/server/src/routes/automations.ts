import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AutomationConfig, CreateAutomationBody } from "@nebula/shared";
import type { Ctx } from "../app";
import { VaultError } from "../signer";

const Id = z.object({ id: z.string().min(1).max(80) });

// REQ-AUTO-001…010: automatizaciones (DCA y límite). Todo requiere la bóveda abierta.
export const automationRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async (req) => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      if (req.method !== "GET") ctx.vault.touch();
    });
    const a = () => ctx.automations;

    app.get("/automations", async (req) => a().list(z.object({ mint: z.string().max(64).optional() }).parse(req.query).mint));
    app.post("/automations", async (req) => a().create(CreateAutomationBody.parse(req.body)));
    app.get("/automations/:id", async (req) => a().view(Id.parse(req.params).id));
    app.patch("/automations/:id", async (req) => {
      const { config, label } = z.object({ config: AutomationConfig, label: z.string().trim().max(60).optional() }).parse(req.body);
      return a().edit(Id.parse(req.params).id, config, label);
    });
    app.get("/automations/:id/executions", async (req) => {
      const q = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).parse(req.query);
      return a().executions(Id.parse(req.params).id, q);
    });
    app.post("/automations/:id/start", async (req) => a().begin(Id.parse(req.params).id));
    app.post("/automations/:id/rerun", async (req) => a().begin(Id.parse(req.params).id));
    app.post("/automations/:id/pause", async (req) => a().pause(Id.parse(req.params).id));
    app.post("/automations/:id/resume", async (req) => a().resume(Id.parse(req.params).id));
    app.post("/automations/:id/stop", async (req) => a().stopTask(Id.parse(req.params).id));
    app.post("/automations/:id/duplicate", async (req) => a().duplicate(Id.parse(req.params).id));
    app.delete("/automations/:id", async (req) => a().remove(Id.parse(req.params).id));
  };
