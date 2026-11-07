import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

// Con el RPC caído (p. ej. mainnet sin configurar, que apunta al RPC local), la API responde 503 con un
// mensaje accionable en lugar de «Error interno».
describe("errores · RPC inalcanzable", () => {
  let close: (() => Promise<unknown>) | undefined;
  afterAll(async () => {
    await close?.();
  });

  it("una petición que necesita el RPC devuelve 503 RPC_UNREACHABLE", async () => {
    const { app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "rpc" });
    close = () => app.close();
    const call = async (method: "POST" | "PUT", url: string, body: unknown) => {
      const res = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, "content-type": "application/json" }, payload: JSON.stringify(body) });
      return { status: res.statusCode, json: res.json() };
    };
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    expect((await call("PUT", "/api/settings", { rpcPrimaryHttp: "http://127.0.0.1:1", rpcPrimaryWs: "ws://127.0.0.1:1" })).status).toBe(200);
    const q = await call("POST", "/api/launches/quote", { devBuyLamports: "10000000", buys: [] });
    expect(q.status, JSON.stringify(q.json)).toBe(503);
    expect(q.json).toMatchObject({ code: "RPC_UNREACHABLE" });
    expect(q.json.message).toMatch(/Ajustes/);
  }, 60_000);
});
