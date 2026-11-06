// REQ-LAUNCH-002..017 y E2E-05/07 contra mock y (NEBULA_CHAIN_TESTS=1) Surfpool.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];
const SOL = 1_000_000_000n;
// PNG de 1×1 px
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe.each(backends)("Lanzamiento real · %s", (backend) => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  let dev: { id: string; address: string };
  let holders: { id: string; address: string }[] = [];
  let poor: { id: string };
  let imageCid = "";

  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  const cfg = (over: Record<string, unknown> = {}) => ({
    draftId: `d-${randomUUID()}`,
    name: "Kepler Test",
    symbol: "KTEST",
    description: "Token de prueba",
    imageCid,
    links: { x: "https://x.com/kepler", telegram: "", web: "" },
    devWalletId: dev.id,
    devBuyLamports: (SOL / 2n).toString(),
    mode: "quick",
    holders: holders.map((h) => ({ walletId: h.id, lamports: (SOL / 5n).toString() })),
    slippagePct: 15,
    mayhem: false,
    feeMode: "creator",
    feeAck: true,
    ...over,
  });
  const until = async (id: string) => {
    for (let i = 0; i < 1200; i++) {
      const v = (await call("GET", `/api/launches/${id}`)).json;
      if (!["CREATING", "CREATED", "BUYING"].includes(v.status)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("El lanzamiento no terminó");
  };

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: backend === "mock" ? "mock" : "rpc" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    dev = (await call("POST", "/api/wallets", { count: 1, role: "dev", labelPrefix: "Dev" })).json.wallets.find((w: { role: string }) => w.role === "dev");
    holders = (await call("POST", "/api/wallets", { count: 3, role: "holder" })).json.wallets.filter((w: { role: string }) => w.role === "holder");
    poor = (await call("POST", "/api/wallets", { count: 1, labelPrefix: "Pobre" })).json.wallets.find((w: { label: string }) => w.label.startsWith("Pobre"));
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 3 });
    await call("POST", "/api/dev/airdrop", { walletIds: holders.map((h) => h.id), sol: 1 });
    imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    if (backend === "surfpool") {
      // sin tabla de direcciones, el dry-run lo dice y no simula una tx que no cabe
      const v = (await call("POST", "/api/launches/preflight", cfg({ mode: "manual", holders: [] }))).json;
      expect(v.preflight.checks[0]).toMatchObject({ kind: "setup", ok: false, action: "create-alt" });
    }
    const alt = await call("POST", "/api/launches/alt", { payerWalletId: dev.id });
    expect(alt.status, JSON.stringify(alt.json)).toBe(200);
  }, 180_000);
  afterAll(async () => {
    await app?.close();
  });

  it("REQ-LAUNCH-002 · la imagen se sube a la API local y los formatos no admitidos se rechazan", async () => {
    expect(imageCid).toMatch(/^local-/);
    expect((await call("POST", "/api/launches/media", { fileB64: Buffer.from("x").toString("base64"), contentType: "application/pdf" })).status).toBe(400);
  });

  it("REQ-LAUNCH-011 · cotización del lanzamiento: cada compra posterior recibe menos tokens por el mismo SOL", async () => {
    const q = (await call("POST", "/api/launches/quote", { devBuyLamports: (SOL / 2n).toString(), buys: ["200000000", "200000000", "200000000"] })).json;
    const t = q.buyTokens.map(BigInt);
    expect(BigInt(q.devTokens)).toBeGreaterThan(0n);
    expect(t[0]).toBeGreaterThan(t[1]);
    expect(t[1]).toBeGreaterThan(t[2]);
    expect(q.graduationPct).toBeGreaterThan(0);
  });

  it("REQ-LAUNCH-017 · el dry-run detecta un holder sin saldo y bloquea el lanzamiento", async () => {
    const c = cfg({ holders: [...holders.map((h) => ({ walletId: h.id, lamports: "200000000" })), { walletId: poor.id, lamports: "200000000" }] });
    const v = (await call("POST", "/api/launches/preflight", c)).json;
    expect(v.preflight.ok).toBe(false);
    expect(v.preflight.checks.find((c: { kind: string }) => c.kind === "simulated")).toMatchObject({ ok: true });
    expect(v.preflight.checks.at(-1)).toMatchObject({ kind: "checked", ok: false });
    expect((await call("POST", `/api/launches/${c.draftId}/execute`)).status).toBe(409);
  });

  it("E2E-05/07 · Quick: create + dev buy en una tx y 3 compras; dos clics seguidos producen un solo token", async () => {
    const c = cfg();
    const q = (await call("POST", "/api/launches/quote", { devBuyLamports: c.devBuyLamports, buys: [] })).json;
    const pf = (await call("POST", "/api/launches/preflight", c)).json;
    expect(pf.preflight.ok, JSON.stringify(pf.preflight)).toBe(true);
    const [a, b] = await Promise.all([call("POST", `/api/launches/${c.draftId}/execute`), call("POST", `/api/launches/${c.draftId}/execute`)]);
    expect(a.json.mint).toBe(b.json.mint);
    const v = await until(c.draftId);
    expect(v.status, JSON.stringify(v)).toBe("DONE");
    expect(v.createSignature).toBeTruthy();
    expect(v.buys.map((x: { status: string }) => x.status)).toEqual(["OK", "OK", "OK"]);
    const devTokens = await ctx.chain.get().reader.tokenBalance(v.mint, dev.address);
    expect(devTokens).toBe(BigInt(q.devTokens));
    for (const h of holders) expect(await ctx.chain.get().reader.tokenBalance(v.mint, h.address)).toBeGreaterThan(0n);
    // un nuevo dry-run del mismo borrador no prepara otro token
    expect((await call("POST", "/api/launches/preflight", c)).json).toMatchObject({ status: "DONE", mint: v.mint });
    expect((await call("POST", `/api/launches/${c.draftId}/execute`)).json).toMatchObject({ status: "DONE", mint: v.mint });
  });

  it("REQ-LAUNCH-010 · Manual: solo create + dev buy", async () => {
    const c = cfg({ mode: "manual", holders: [], symbol: "KMAN", devBuyLamports: (SOL / 10n).toString() });
    expect((await call("POST", "/api/launches/preflight", c)).json.preflight.ok).toBe(true);
    await call("POST", `/api/launches/${c.draftId}/execute`);
    const v = await until(c.draftId);
    expect(v).toMatchObject({ status: "DONE", buys: [] });
  });

  it.runIf(backend === "mock")("RPC caído al crear: el lanzamiento queda en pausa y al reanudar comprueba el mint y termina", async () => {
    const c = cfg({ mode: "manual", holders: [], symbol: "KPAU" });
    expect((await call("POST", "/api/launches/preflight", c)).json.preflight.ok).toBe(true);
    ctx.chain.get().ledger!.failures.push("RPC_DOWN");
    await call("POST", `/api/launches/${c.draftId}/execute`);
    const paused = await until(c.draftId);
    expect(paused).toMatchObject({ status: "PAUSED", pausedFrom: "CREATING" });
    expect((await call("GET", "/api/vault/status")).json.paused.some((p: { id: string }) => p.id === c.draftId)).toBe(true);
    await call("POST", `/api/launches/${c.draftId}/resume`);
    expect((await until(c.draftId)).status).toBe("DONE");
  });
});

describe("Mainnet sin IPFS verificado", () => {
  it("la subida de medios se bloquea con un mensaje claro", async () => {
    const { app, ctx } = await buildApp({ profile: "mainnet", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
    await ctx.vault.setup(PW);
    const r = await app.inject({ method: "POST", url: "/api/launches/media", headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, "content-type": "application/json" }, payload: JSON.stringify({ fileB64: PNG, contentType: "image/png" }) });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "IPFS_UNAVAILABLE" });
    await app.close();
  });
});
