// REQ-LAUNCH-005: clonar los metadatos de un token rellena el borrador (todo editable) y la descarga de
// URIs ajenas está acotada (solo https a hosts públicos, tamaño y tipo de imagen).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";
import { isPrivateIp, safeFetch } from "../src/clone";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("REQ-LAUNCH-005 · clonar metadatos", () => {
  it("clona nombre, símbolo, descripción, enlaces e imagen de un token lanzado; no lanza nada", async () => {
    const { app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
    const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
      const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.statusCode, json: r.json() };
    };
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const dev = (await call("POST", "/api/wallets", { count: 1, role: "dev" })).json.wallets[0];
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 2 });
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    await call("POST", "/api/launches/alt", { payerWalletId: dev.id });
    const draftId = `d-${randomUUID()}`;
    await call("POST", "/api/launches/preflight", { draftId, name: "Original Coin", symbol: "ORIG", description: "Una descripción original", imageCid, links: { x: "https://x.com/original", telegram: "https://t.me/original", web: "https://original.example" }, devWalletId: dev.id, devBuyLamports: "100000000", mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true });
    await call("POST", `/api/launches/${draftId}/execute`, {});
    const mint = (await ctx.launches.waitIdle(draftId)).mint;
    const launchesBefore = (ctx.db().prepare("SELECT COUNT(*) AS n FROM launch").get() as { n: number }).n;

    const c = await call("POST", "/api/launches/clone", { mint });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json).toMatchObject({ mint, source: "nebula", name: "Original Coin", symbol: "ORIG", description: "Una descripción original", links: { x: "https://x.com/original", telegram: "https://t.me/original", web: "https://original.example/" }, warnings: [] });
    expect(c.json.image).toMatchObject({ cid: imageCid, contentType: "image/png" });
    expect(c.json.image.preview).toMatch(/^data:image\/png;base64,/);
    expect((ctx.db().prepare("SELECT COUNT(*) AS n FROM launch").get() as { n: number }).n).toBe(launchesBefore);
    expect((await call("POST", "/api/launches/clone", { mint: "no-es-una-direccion" })).status).toBe(400);
    await app.close();
  });

  it("la descarga rechaza http, IPs privadas o locales y archivos demasiado grandes", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "104.16.1.1", "2606:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
    await expect(safeFetch("http://example.com/meta.json", 1000)).rejects.toThrow(/https/);
    await expect(safeFetch("https://127.0.0.1/meta.json", 1000)).rejects.toThrow(/privada o local/);
    await expect(safeFetch("https://[::1]/x", 1000)).rejects.toThrow(/privada o local/);
    // redirección hacia una IP privada: se comprueba cada salto
    const redirecting = (async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secreto" } })) as unknown as typeof fetch;
    await expect(safeFetch("https://8.8.8.8/meta.json", 1000, redirecting)).rejects.toThrow(/privada o local/);
    const big = (async () => new Response(new Uint8Array(5000), { status: 200 })) as unknown as typeof fetch;
    await expect(safeFetch("https://8.8.8.8/meta.json", 1000, big)).rejects.toThrow(/demasiado grande/);
  });
});
