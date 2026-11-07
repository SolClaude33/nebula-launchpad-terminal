// REQ-LIVE-006: tracker de tokens (con el mock de la cadena).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("REQ-LIVE-006 · tracker", () => {
  it("añade un token de Pump.fun, lo lista con su market cap y graduación, rechaza los que no existen y lo quita", async () => {
    const { app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
    const call = async (method: "GET" | "POST" | "DELETE", url: string, body?: unknown) => {
      const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.statusCode, json: r.json() };
    };
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const dev = (await call("POST", "/api/wallets", { count: 1, role: "dev" })).json.wallets[0];
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 2 });
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    await call("POST", "/api/launches/alt", { payerWalletId: dev.id });
    const draftId = `d-${randomUUID()}`;
    await call("POST", "/api/launches/preflight", { draftId, name: "Seguido", symbol: "SEG", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: "100000000", mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true });
    await call("POST", `/api/launches/${draftId}/execute`, {});
    const mint = (await ctx.launches.waitIdle(draftId)).mint;

    expect((await call("POST", "/api/tracker", { mint })).json).toEqual({ added: true });
    expect((await call("POST", "/api/tracker", { mint })).json).toEqual({ added: false }); // ya estaba
    const list = (await call("GET", "/api/tracker")).json.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ mint, symbol: "SEG", own: true, venue: "curve", error: null });
    expect(Number(list[0].marketCapLamports)).toBeGreaterThan(0);
    expect(list[0].graduationPct).toBeGreaterThan(0);
    expect((await call("GET", "/api/tracker?lite=1")).json.items[0]).toMatchObject({ mint, symbol: "SEG" });
    // un mint que no existe (o no es de Pump.fun) no entra
    expect((await call("POST", "/api/tracker", { mint: "So11111111111111111111111111111111111111112" })).status).toBe(404);
    expect((await call("POST", "/api/tracker", { mint: "no es un mint" })).status).toBe(400);
    expect((await call("DELETE", `/api/tracker/${mint}`)).json).toEqual({ removed: true });
    expect((await call("GET", "/api/tracker")).json.items).toHaveLength(0);
    await app.close();
  });
});
