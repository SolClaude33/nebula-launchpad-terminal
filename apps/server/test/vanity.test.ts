// REQ-LAUNCH-006 · mint vanity: búsqueda en hilos aparte (cancelable, la API sigue respondiendo), importación
// con la clave a la bóveda, y el dry-run usa ese mint mientras la creación no se haya enviado nunca.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { buildApp } from "../src/app";
import { b58encode } from "../src/base58";
import { expectedAttempts, patternIssue } from "../src/vanity";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("REQ-LAUNCH-006 · patrones vanity", () => {
  it("valida el alfabeto base58 y la longitud, y estima los intentos", () => {
    expect(patternIssue("", "", false)).toMatch(/prefijo o un sufijo/);
    expect(patternIssue("0x", "", false)).toMatch(/base58/);
    expect(patternIssue("", "pumpxy", false)).toMatch(/Como máximo/);
    expect(patternIssue("1a", "", false)).toMatch(/imposible/);
    expect(patternIssue("", "pump", false)).toBeNull();
    expect(expectedAttempts("", "pump", false)).toBe(58 ** 4);
    // sin distinguir mayúsculas: «p», «u» y «m» tienen dos variantes válidas; «l» solo una (no existe «l» pero sí «L»)
    expect(expectedAttempts("", "pum", true)).toBe(Math.round((58 / 2) ** 3));
  });
});

describe("REQ-LAUNCH-006 · mint vanity (mock)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  let devId = "";
  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    devId = (await call("POST", "/api/wallets", { count: 1, role: "dev", labelPrefix: "Dev" })).json.wallets[0].id;
    await call("POST", "/api/dev/airdrop", { walletIds: [devId], sol: 2 });
  });
  afterAll(async () => {
    ctx?.vanity.cancelAll();
    await app?.close();
  });

  it("genera un mint con sufijo en hilos aparte, lo sella en la bóveda y el lanzamiento lo usa", async () => {
    const draftId = `d-${randomUUID()}`;
    const st = await call("POST", `/api/launches/${draftId}/vanity/generate`, { suffix: "z", ci: false });
    expect(st.status, JSON.stringify(st.json)).toBe(200);
    expect(st.json.job).toMatchObject({ status: "RUNNING", expected: 58 });
    let v = st.json;
    for (let i = 0; i < 200 && v.job.status === "RUNNING"; i++) {
      // la API sigue respondiendo mientras buscan los hilos
      expect((await call("GET", "/api/chain/status")).status).toBe(200);
      await sleep(50);
      v = (await call("GET", `/api/launches/${draftId}/vanity`)).json;
    }
    // al terminar, el mint ya está ligado (nunca FOUND sin dirección)
    expect(v.job.status).toBe("FOUND");
    expect(v.bound).toMatch(/z$/);
    // la clave está en la bóveda (puede firmar) y el dry-run y el lanzamiento usan ese mint
    expect(ctx.db().prepare("SELECT 1 FROM mint_key WHERE address = ?").get(v.bound)).toBeTruthy();
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    const cfg = { draftId, name: "Vanity", symbol: "VNTY", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: devId, devBuyLamports: "100000000", mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true };
    const pf = (await call("POST", "/api/launches/preflight", cfg)).json;
    expect(pf.mint).toBe(v.bound);
    await call("POST", `/api/launches/${draftId}/execute`, {});
    const done = await ctx.launches.waitIdle(draftId);
    expect(done.status).toBe("DONE");
    expect(done.mint).toBe(v.bound);
    // ya enviado: su mint no se puede cambiar
    expect((await call("POST", `/api/launches/${draftId}/vanity/clear`)).status).toBe(409);
  });

  it("cancelar para los hilos; un patrón imposible se rechaza", async () => {
    const draftId = `d-${randomUUID()}`;
    expect((await call("POST", `/api/launches/${draftId}/vanity/generate`, { prefix: "0" })).status).toBe(400);
    await call("POST", `/api/launches/${draftId}/vanity/generate`, { prefix: "zzzzz" });
    const c = (await call("POST", `/api/launches/${draftId}/vanity/cancel`)).json;
    expect(c.job.status).toBe("CANCELLED");
    expect(c.bound).toBeNull();
  });

  it("importar: la clave va a la bóveda; una wallet propia o un mint ya lanzado se rechazan", async () => {
    const draftId = `d-${randomUUID()}`;
    const kp = Keypair.generate();
    const r = await call("POST", `/api/launches/${draftId}/vanity/import`, { secret: b58encode(kp.secretKey) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.bound).toBe(kp.publicKey.toBase58());
    // el mismo mint en otro borrador: ya lo usa este
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    await call("POST", "/api/launches/preflight", { draftId, name: "Imp", symbol: "IMP", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: devId, devBuyLamports: "100000000", mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true });
    expect((await call("POST", `/api/launches/d-${randomUUID()}/vanity/import`, { secret: b58encode(kp.secretKey) })).status).toBe(409);
    // la clave de una wallet de la bóveda no es un mint
    const w = ctx.db().prepare("SELECT id, encrypted_key FROM wallet WHERE id = ?").get(devId) as { id: string; encrypted_key: Buffer };
    const devSecret = ctx.vault.revealKey(w.id, w.encrypted_key);
    expect((await call("POST", `/api/launches/d-${randomUUID()}/vanity/import`, { secret: devSecret })).status).toBe(400);
    // basura
    expect((await call("POST", `/api/launches/d-${randomUUID()}/vanity/import`, { secret: "x".repeat(40) })).status).toBe(400);
  });
});
