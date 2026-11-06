import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { STEP_UP_HEADER } from "@nebula/shared";
import type { Ctx } from "../app";
import { OperationInput } from "../operations";
import { VaultError } from "../signer";
import { isValidAddress } from "../chain/transfers";

export const operationRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async (req) => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      if (req.method !== "GET") ctx.vault.touch();
    });

    // Vista previa: calcula montos, fees y avisos sin enviar nada; guarda el plan en el servidor
    app.post("/operations/preview", async (req) => ctx.ops.preview(OperationInput.parse(req.body)));

    // Ejecuta el plan guardado (los retiros exigen reconfirmación; lo decide el servidor)
    app.post("/operations/:id/execute", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.ops.execute(id, req.headers[STEP_UP_HEADER] as string | undefined);
    });

    app.post("/operations/:id/resume", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.ops.resume(id);
    });

    app.get("/operations/:id", async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      return ctx.ops.get(id);
    });

    app.get("/operations", async (req) => {
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
      return { items: ctx.ops.list(limit) };
    });

    // Saldo de una sola wallet propia (el QR de depósito sondea cada 2 s, REQ-FUND-002)
    app.get("/balance/:address", async (req) => {
      const { address } = z.object({ address: z.string() }).parse(req.params);
      if (!ctx.db().prepare("SELECT 1 FROM wallet WHERE address = ?").get(address)) throw Object.assign(new Error("No es una wallet propia"), { statusCode: 404 });
      const m = await ctx.chain.get().reader.balances([address]);
      return { address, lamports: (m.get(address) ?? 0n).toString(), at: Date.now() };
    });

    // REQ-FUND-003: libreta de direcciones
    app.get("/address-book", async () => ({ items: ctx.db().prepare("SELECT address, label, created_at AS createdAt FROM address_book ORDER BY created_at DESC").all() }));
    app.post("/address-book", async (req) => {
      const { address, label } = z.object({ address: z.string().trim(), label: z.string().trim().min(1).max(40) }).parse(req.body);
      if (!isValidAddress(address)) throw Object.assign(new Error("Dirección no válida"), { statusCode: 400 });
      ctx.db().prepare("INSERT INTO address_book(address, label, created_at) VALUES(?, ?, ?) ON CONFLICT(address) DO UPDATE SET label = excluded.label").run(address, label, Date.now());
      return { ok: true };
    });
    app.delete("/address-book/:address", async (req) => {
      const { address } = z.object({ address: z.string() }).parse(req.params);
      ctx.db().prepare("DELETE FROM address_book WHERE address = ?").run(address);
      return { ok: true };
    });
  };
