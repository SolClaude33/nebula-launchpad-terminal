// Cerrar la tabla de direcciones de lanzamiento para recuperar su rent (resto «Should» de F1).
// Solo contra Surfpool (NEBULA_CHAIN_TESTS=1): el mock no usa tabla. Desactivar → esperar ~512 slots (aquí con
// una espera real) → cerrar; el rent llega entero al destino y la siguiente creación hace una tabla nueva.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

describe.runIf(process.env.NEBULA_CHAIN_TESTS === "1")("Cerrar la tabla de direcciones · surfpool", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  type W = { id: string; address: string; label: string; kind: string };
  let dev: W, funder: W;

  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  const sol = async (a: string) => (await ctx.chain.get().reader.balances([a])).get(a)!;

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "rpc" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    dev = ((await call("POST", "/api/wallets", { count: 1, labelPrefix: "Dev", role: "dev" })).json.wallets as W[]).find((w) => w.label.startsWith("Dev"))!;
    funder = ((await call("POST", "/api/wallets", { count: 1, kind: "funder" })).json.wallets as W[]).find((w) => w.kind === "funder")!;
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id, funder.id], sol: 1 });
    expect((await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).status).toBe(200);
  }, 240_000);
  afterAll(async () => {
    await app?.close();
  });

  it("desactivar (bloqueado con un lanzamiento en curso), esperar, cerrar y recuperar el rent al lamport", async () => {
    const info = (await call("GET", "/api/launches/alt")).json;
    expect(info.current).toMatchObject({ authorityWallet: { id: dev.id } });
    expect(info.closing).toBeNull();
    const lamports = BigInt(info.current.lamports);
    expect(lamports).toBeGreaterThan(0n);

    // un lanzamiento en curso bloquea la desactivación
    const now = Date.now();
    ctx.db().prepare("INSERT INTO launch(id, status, config, mint, created_at, updated_at) VALUES('l-curso', 'BUYING', '{}', 'x', ?, ?)").run(now, now);
    expect((await call("POST", "/api/launches/alt/deactivate")).status).toBe(409);
    ctx.db().prepare("DELETE FROM launch WHERE id = 'l-curso'").run();

    const d = await call("POST", "/api/launches/alt/deactivate");
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json.current).toBeNull();
    expect(d.json.closing.slotsLeft).toBeGreaterThan(0);
    // la tabla desactivada ya no sirve para crear tokens
    expect((await ctx.chain.get().launchAlt.status()).ready).toBe(false);
    // cerrar antes de tiempo se rechaza
    expect((await call("POST", "/api/launches/alt/close", { recipientId: funder.id })).status).toBe(409);

    // Esperar de verdad (~512 slots ≈ 130 s en Surfpool): surfnet_timeTravel sube el slot pero no rellena SlotHashes,
    // y el programa sigue viendo la tabla «desactivándose» (comprobado el 2026-11-07)
    const before = await sol(funder.address);
    let c = { status: 0, json: {} as Record<string, unknown> };
    for (let i = 0; i < 60; i++) {
      const st = (await call("GET", "/api/launches/alt")).json;
      if (st.closing.slotsLeft === 0) {
        c = await call("POST", "/api/launches/alt/close", { recipientId: funder.id });
        if (c.status === 200) break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    // el destino recibe el rent entero (la fee la paga la autoridad) y la tabla deja de existir
    expect((await sol(funder.address)) - before).toBe(lamports);
    expect(await ctx.chain.get().reader.accountExists(info.current.address)).toBe(false);
    expect((await call("GET", "/api/launches/alt")).json).toMatchObject({ current: null, closing: null });

    // la siguiente preparación de lanzamiento crea una tabla nueva
    const again = (await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).json;
    expect(again.created).toBe(true);
    expect(again.address).not.toBe(info.current.address);
  }, 420_000);
});
