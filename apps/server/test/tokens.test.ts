// REQ-LIVE-005 contra mock y (NEBULA_CHAIN_TESTS=1) Surfpool: enviar tokens (a una wallet propia o a una
// dirección externa con reconfirmación) y quemar supply confirmando con el símbolo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];
const SOL = 1_000_000_000n;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe.each(backends)("Enviar y quemar tokens · %s", (backend) => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  type W = { id: string; address: string; label: string };
  let dev: W;
  let holder: W;
  let mint = "";

  const call = async (method: "GET" | "POST", url: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  const tokens = (a: string) => ctx.chain.get().reader.tokenBalance(mint, a);
  const stepUp = async () => (await call("POST", "/api/vault/confirm", { password: PW, action: "withdraw" })).json.token as string;

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: backend === "mock" ? "mock" : "rpc" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    dev = (await call("POST", "/api/wallets", { count: 1, role: "dev", labelPrefix: "Dev" })).json.wallets.find((w: W) => w.label.startsWith("Dev"));
    holder = (await call("POST", "/api/wallets", { count: 1, role: "holder", labelPrefix: "Holder" })).json.wallets.find((w: W) => w.label.startsWith("Holder"));
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 3 });
    await call("POST", "/api/dev/airdrop", { walletIds: [holder.id], sol: 0.1 });
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    expect((await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).status).toBe(200);
    const draftId = `d-${randomUUID()}`;
    const cfg = { draftId, name: "Quema Test", symbol: "BURN", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: ((SOL * 3n) / 10n).toString(), mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true };
    expect((await call("POST", "/api/launches/preflight", cfg)).json.preflight.ok).toBe(true);
    await call("POST", `/api/launches/${draftId}/execute`, {});
    mint = (await ctx.launches.waitIdle(draftId)).mint;
  }, 240_000);
  afterAll(async () => {
    await app?.close();
  });

  it("enviar el 25 % a una wallet propia: vista previa con el rent de su cuenta nueva y sin reconfirmar", async () => {
    const before = await tokens(dev.address);
    const body = { id: randomUUID(), mint, walletIds: [dev.id], to: holder.address, pct: 25 };
    const pv = (await call("POST", "/api/tokens/send/preview", body)).json;
    expect(pv).toMatchObject({ needsStepUp: false, to: { own: { id: holder.id } }, symbol: "BURN" });
    expect(BigInt(pv.items[0].amount)).toBe(before / 4n);
    expect(BigInt(pv.items[0].rentLamports)).toBeGreaterThan(0n); // el holder aún no tiene cuenta de token
    expect(BigInt(pv.items[0].feeLamports)).toBeGreaterThan(0n);
    const r = await call("POST", "/api/tokens/send", body);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items[0]).toMatchObject({ status: "OK" });
    expect(await tokens(holder.address)).toBe(before / 4n);
    expect(await tokens(dev.address)).toBe(before - before / 4n);
    // repetir la misma petición (mismo id) no vuelve a enviar
    await call("POST", "/api/tokens/send", body);
    expect(await tokens(holder.address)).toBe(before / 4n);
  }, 120_000);

  it("a una dirección externa nueva: aviso, exige reconfirmar y una PDA se rechaza", async () => {
    const ext = Keypair.generate().publicKey.toBase58();
    const body = { id: randomUUID(), mint, walletIds: [holder.id], to: ext, tokensEach: "1000000" };
    const pv = (await call("POST", "/api/tokens/send/preview", body)).json;
    expect(pv).toMatchObject({ needsStepUp: true, to: { own: null, newAddress: true, offCurve: false } });
    expect((await call("POST", "/api/tokens/send", body)).status).toBe(403);
    const r = await call("POST", "/api/tokens/send", body, { "x-nebula-stepup": await stepUp() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await tokens(ext)).toBe(1_000_000n);
    // ya está en la libreta: la próxima vez no es «nueva»
    expect((await call("POST", "/api/tokens/send/preview", { ...body, id: randomUUID() })).json.to.newAddress).toBe(false);
    const pda = PublicKey.findProgramAddressSync([Buffer.from("nebula")], new PublicKey("11111111111111111111111111111111"))[0].toBase58();
    const tok = await stepUp();
    const bad = await call("POST", "/api/tokens/send", { ...body, id: randomUUID(), to: pda }, { "x-nebula-stepup": tok });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/PDA/);
    // REVIEW-F1 P3-9: el rechazo no gasta la reconfirmación
    const again = await call("POST", "/api/tokens/send", { ...body, id: randomUUID(), to: Keypair.generate().publicKey.toBase58() }, { "x-nebula-stepup": tok });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    const act = (await call("GET", "/api/activity?kind=tokens")).json.items as { kind: string; detail: string }[];
    expect(act.some((a) => a.kind === "tokens.send" && a.detail.includes(ext))).toBe(true);
  }, 120_000);

  it.runIf(backend === "mock")("REVIEW-F1 P2-6 · dos peticiones simultáneas con el mismo id: una se rechaza y se quema una sola vez", async () => {
    const own = await tokens(dev.address);
    // con un RPC real, leer el símbolo tarda: las dos peticiones están a la vez dentro de execute
    const realSymbol = ctx.tokenOps.symbolOf.bind(ctx.tokenOps);
    ctx.tokenOps.symbolOf = async (m: string) => (await new Promise((r) => setTimeout(r, 200)), realSymbol(m));
    const body = { id: randomUUID(), mint, walletIds: [dev.id], tokensEach: "1000000", confirmSymbol: "BURN" };
    const [a, b] = await Promise.all([call("POST", "/api/tokens/burn", body), call("POST", "/api/tokens/burn", body)]);
    ctx.tokenOps.symbolOf = realSymbol;
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await tokens(dev.address)).toBe(own - 1_000_000n);
  });

  it("quemar el 100 % exige escribir el símbolo y baja la supply exactamente", async () => {
    const own = await tokens(dev.address);
    const supply0 = BigInt((await call("GET", `/api/live/${mint}`)).json.info.supply);
    const body = { id: randomUUID(), mint, walletIds: [dev.id], pct: 100 };
    const pv = (await call("POST", "/api/tokens/burn/preview", { ...body, confirmSymbol: "" })).json;
    expect(BigInt(pv.items[0].amount)).toBe(own);
    expect(pv.items[0].rentLamports).toBe("0");
    expect((await call("POST", "/api/tokens/burn", { ...body, confirmSymbol: "OTRO" })).status).toBe(400);
    expect(await tokens(dev.address)).toBe(own);
    const r = await call("POST", "/api/tokens/burn", { ...body, confirmSymbol: "$burn" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items[0].status).toBe("OK");
    expect(await tokens(dev.address)).toBe(0n);
    ctx.live.stopAll(); // lectura fresca de la supply
    const supply1 = BigInt((await call("GET", `/api/live/${mint}`)).json.info.supply);
    expect(supply1).toBe(supply0 - own);
    // repetir (mismo id) no quema dos veces: la wallet ya no tiene tokens y se omite
    const again = (await call("POST", "/api/tokens/burn", { ...body, confirmSymbol: "BURN" })).json;
    expect(again.items[0].status).toBe("SKIPPED");
  }, 120_000);
});
