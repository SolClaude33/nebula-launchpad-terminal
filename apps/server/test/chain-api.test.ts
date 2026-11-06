import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { makeApp, PW, tmpDir, HOST, ORIGIN } from "./helpers";

type App = Awaited<ReturnType<typeof makeApp>>;
const apps: { app: { close: () => Promise<unknown> } }[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.app.close();
});

describe("API de cadena", () => {
  it("E2E-04 (parcial) · airdrop de prueba y saldos reales por wallet", async () => {
    const a: App = await makeApp();
    apps.push(a);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    expect((await a.call("GET", "/api/chain/status")).json).toMatchObject({ profile: "test", mode: "mock", healthy: true });
    const ws = (await a.call("POST", "/api/wallets", { count: 3, kind: "funder" })).json.wallets;
    const ids = ws.map((w: { id: string }) => w.id);
    expect((await a.call("POST", "/api/dev/airdrop", { walletIds: ids.slice(0, 2), sol: 10 })).json.ok).toBe(2);
    const b = (await a.call("GET", "/api/wallets/balances")).json.balances;
    expect(b[ws[0].address]).toBe("10000000000");
    expect(b[ws[2].address]).toBe("0");
    expect((await a.call("POST", "/api/dev/airdrop", { walletIds: ids, sol: 1000 })).status).toBe(400);
  });

  it("perfil de pruebas con un RPC no local: la cadena queda desactivada con el motivo", async () => {
    const a: App = await makeApp();
    apps.push(a);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const { app, ctx } = await buildApp({ profile: "test", dataDir: a.dataDir + "-x", token: "t".repeat(64), logToStdout: false, chainMode: "rpc" });
    apps.push({ app });
    await ctx.vault.setup(PW);
    const inj = (method: "GET" | "PUT", url: string, body?: unknown) =>
      app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body ? { "content-type": "application/json" } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    await inj("PUT", "/api/settings", { rpcPrimaryHttp: "https://api.mainnet-beta.solana.com" });
    const st = (await inj("GET", "/api/chain/status")).json();
    expect(st).toMatchObject({ mode: "off", healthy: false });
    expect(st.error).toMatch(/debe ser local/);
    expect((await inj("GET", "/api/wallets/balances")).statusCode).toBe(409);
  });

  it("el airdrop no existe en mainnet", async () => {
    const { app, ctx } = await buildApp({ profile: "mainnet", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
    apps.push({ app });
    await ctx.vault.setup(PW);
    const r = await app.inject({ method: "POST", url: "/api/dev/airdrop", headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, "content-type": "application/json" }, payload: JSON.stringify({ walletIds: ["x"], sol: 1 }) });
    expect(r.statusCode).toBe(404);
  });
});
