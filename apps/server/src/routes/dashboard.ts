import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app";
import { VaultError } from "../signer";

export const dashboardRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async () => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
    });
    // REQ-DASH-001/002: P&L por período, saldo total y lanzamientos
    app.get("/dashboard", async (req) => {
      const { period, tz } = z.object({ period: z.enum(["24h", "7d", "30d", "1y", "all"]).default("30d"), tz: z.coerce.number().int().min(-840).max(840).default(0) }).parse(req.query);
      return ctx.pnl.summary(period, tz);
    });
    // REQ-WAL-009: actividad de una wallet (datos locales, sin peticiones extra al RPC)
    app.get("/wallets/:id/activity", async (req) => ctx.pnl.activity(z.object({ id: z.string() }).parse(req.params).id));
    // REQ-DASH-003: calendario de P&L por días de un mes o por meses de un año
    app.get("/dashboard/calendar", async (req) => {
      const q = z.object({ year: z.coerce.number().int().min(2020).max(2100), month: z.coerce.number().int().min(1).max(12).optional(), tz: z.coerce.number().int().min(-840).max(840).default(0) }).parse(req.query);
      return ctx.pnl.calendar(q.year, q.month ?? null, q.tz);
    });
  };
