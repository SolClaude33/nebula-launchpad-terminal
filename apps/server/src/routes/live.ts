import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app";
import { VaultError } from "../signer";
import { isValidAddress } from "../chain/transfers";
import { OrderInput, QuoteInput } from "../trading";
import { logActivity } from "../db";

const Mint = z.object({ mint: z.string().refine((v) => isValidAddress(v) || /^[\w-]{8,64}$/.test(v), "Dirección de token no válida") });

export const liveRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    app.addHook("preHandler", async (req) => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      if (req.method !== "GET") ctx.vault.touch();
    });

    // REQ-LIVE-001: estado del token y trades nuevos desde el cursor (la interfaz sondea cada segundo)
    app.get("/live/:mint", async (req) => {
      const { mint } = Mint.parse(req.params);
      const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query);
      return ctx.live.snapshot(mint, after);
    });
    app.get("/live/:mint/holders", async (req) => ctx.live.holders(Mint.parse(req.params).mint));
    app.get("/live/:mint/position", async (req) => ctx.live.position(Mint.parse(req.params).mint));

    // REQ-LIVE-002 / REQ-COST-001: vista previa con desglose de costes por wallet
    app.post("/trade/quote", async (req) => ctx.trading.quote(QuoteInput.parse(req.body)));
    app.post("/trade", async (req) => ctx.trading.create(OrderInput.parse(req.body)));
    app.get("/trade/:id", async (req) => ctx.trading.view(z.object({ id: z.string() }).parse(req.params).id));
    app.post("/trade/:id/resume", async (req) => ctx.trading.resume(z.object({ id: z.string() }).parse(req.params).id));

    // REQ-REW-001/002: comisiones de creador
    app.get("/rewards", async () => ctx.rewards.scan());
    app.post("/rewards/preview", async (req) => {
      const b = z.object({ walletIds: z.array(z.string()).min(1).max(200), fund: z.boolean().optional() }).parse(req.body);
      return ctx.rewards.preview(b.walletIds, { fund: b.fund ?? false });
    });
    app.post("/rewards/:id/execute", async (req) => ctx.rewards.execute(z.object({ id: z.string() }).parse(req.params).id));
    app.post("/rewards/:id/resume", async (req) => ctx.rewards.resume(z.object({ id: z.string() }).parse(req.params).id));
    app.get("/rewards/:id", async (req) => ctx.rewards.view(z.object({ id: z.string() }).parse(req.params).id));
    // REQ-WAL-010: recuperar rent de cuentas de token vacías
    app.get("/reclaim", async () => ctx.reclaim.scan());
    app.post("/reclaim/preview", async (req) => {
      const b = z.object({ walletIds: z.array(z.string()).min(1).max(500), toId: z.string() }).parse(req.body);
      return ctx.reclaim.preview(b.walletIds, b.toId);
    });
    app.post("/reclaim/:id/execute", async (req) => ctx.reclaim.execute(z.object({ id: z.string() }).parse(req.params).id));
    app.post("/reclaim/:id/resume", async (req) => ctx.reclaim.resume(z.object({ id: z.string() }).parse(req.params).id));
    app.get("/reclaim/:id", async (req) => ctx.reclaim.view(z.object({ id: z.string() }).parse(req.params).id));

    // Solo en el perfil de pruebas: en mainnet la migración a PumpSwap la hace Pump.fun
    app.post("/dev/migrate", async (req) => {
      if (ctx.profile !== "test") throw Object.assign(new Error("La migración manual solo existe en el perfil de pruebas."), { statusCode: 404 });
      const { mint, payerWalletId } = z.object({ mint: z.string(), payerWalletId: z.string() }).parse(req.body);
      const w = ctx.db().prepare("SELECT address, label FROM wallet WHERE id = ? AND archived = 0").get(payerWalletId) as { address: string; label: string } | undefined;
      if (!w) throw Object.assign(new Error("Wallet no encontrada"), { statusCode: 404 });
      const chain = ctx.chain.get();
      const info = await chain.adapter.tokenInfo(mint);
      if (info.venue !== "migrating") throw Object.assign(new Error(info.venue === "curve" ? "La curva aún no está completa." : "El token ya está en PumpSwap."), { statusCode: 409 });
      const res = await chain.sender.send(await chain.adapter.buildMigrateTx({ mint, payer: w.address }), { idempotencyKey: `migrate:${mint}` });
      if (res.status === "failed") throw Object.assign(new Error(res.message), { statusCode: 409 });
      logActivity(ctx.db(), "dev.migrate", `Migración de prueba a PumpSwap de ${mint}, pagada por ${w.label}`);
      void ctx.live.refresh(mint);
      return res.status === "confirmed" ? { status: "confirmed", signature: res.signature } : { status: res.status, message: "message" in res ? res.message : undefined };
    });
  };
