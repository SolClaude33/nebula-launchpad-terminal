import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Ctx } from "../app";
import { logActivity } from "../db";
import { VaultError } from "../signer";
import { solToLamports } from "../chain/types";
import { storedSettings } from "../settings";

export const chainRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    // Estado del RPC para la topbar: no expone nada sensible y no cuenta como actividad
    // sendPerSec: límite de envíos por segundo de Ajustes (p. ej. 1 en Helius Free); 0 = sin límite
    // jito: propina por compra, venta y creación (0 si está apagado) para las vistas previas de la web; `simulated` en
    // el perfil de pruebas (la propina va en la tx, pero no se envía nada al Block Engine)
    app.get("/chain/status", async () => {
      const j = ctx.chain.jito();
      return { profile: ctx.profile, ...ctx.chain.state(), sendPerSec: storedSettings(ctx.db()).rpcSendPerSec ?? 0, jito: { enabled: j.enabled, tipLamports: (j.enabled ? j.tipLamports : 0n).toString(), simulated: j.simulated } };
    });

    // Saldos de todas las wallets activas (lecturas en lotes de 100)
    app.get("/wallets/balances", async () => {
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      const rows = ctx.db().prepare("SELECT address FROM wallet WHERE archived = 0").all() as { address: string }[];
      const map = await ctx.chain.get().reader.balances(rows.map((r) => r.address));
      return { at: Date.now(), balances: Object.fromEntries([...map].map(([a, l]) => [a, l.toString()])) };
    });

    // Solo en el perfil de pruebas y con un RPC local: llena wallets propias con SOL de prueba
    app.post("/dev/airdrop", async (req) => {
      if (ctx.profile !== "test") throw Object.assign(new Error("El airdrop solo existe en el perfil de pruebas."), { statusCode: 404 });
      if (!ctx.vault.isUnlocked()) throw new VaultError("LOCKED", "La bóveda está bloqueada.");
      ctx.vault.touch();
      const { walletIds, sol } = z.object({ walletIds: z.array(z.string()).min(1).max(100), sol: z.number().positive().max(100) }).parse(req.body);
      const chain = ctx.chain.get();
      if (!chain.reader.airdrop) throw Object.assign(new Error("Este RPC no admite airdrop."), { statusCode: 409 });
      const get = ctx.db().prepare("SELECT address, label FROM wallet WHERE id = ?");
      const done: string[] = [];
      for (const id of walletIds) {
        const w = get.get(id) as { address: string; label: string } | undefined;
        if (!w) continue;
        await chain.reader.airdrop(w.address, solToLamports(sol));
        done.push(w.label);
      }
      logActivity(ctx.db(), "dev.airdrop", `Airdrop de prueba de ${sol} SOL a ${done.length} wallets`);
      return { ok: done.length };
    });
  };
