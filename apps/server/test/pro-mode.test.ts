// Modo Pro: como Quick, pero cada wallet del plan espera unos segundos fijos (sin aleatoriedad) antes de su
// compra, contados desde que se confirmó la compra anterior o la creación. Una pausa o un bloqueo cortan la espera.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const SOL = 1_000_000_000n;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type W = { id: string; label: string };
type Buy = { ord: number; status: string; delayMs: number; sentAfterMs: number | null };

describe("modo Pro · espera fija por wallet", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  let dev: W;
  let holders: W[] = [];
  let imageCid = "";

  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  const cfg = (mode: string, delays: number[]) => ({
    draftId: `d-${randomUUID()}`,
    name: "Modo Pro",
    symbol: "PRO",
    description: "",
    imageCid,
    links: { x: "", telegram: "", web: "" },
    devWalletId: dev.id,
    devBuyLamports: (SOL / 10n).toString(),
    mode,
    holders: delays.map((d, i) => ({ walletId: holders[i].id, lamports: (SOL / 20n).toString(), delayMs: d })),
    slippagePct: 25,
    mayhem: false,
    feeMode: "creator",
    feeAck: true,
  });
  const launch = async (c: ReturnType<typeof cfg>) => {
    const pf = await call("POST", "/api/launches/preflight", c);
    expect(pf.json.preflight?.ok, JSON.stringify(pf.json)).toBe(true);
    await call("POST", `/api/launches/${c.draftId}/execute`, {});
    return c.draftId;
  };

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    dev = (await call("POST", "/api/wallets", { count: 1, role: "dev", labelPrefix: "Dev" })).json.wallets.find((w: W) => w.label.startsWith("Dev"));
    holders = (await call("POST", "/api/wallets", { count: 3, role: "holder", labelPrefix: "Snipe" })).json.wallets.filter((w: W) => w.label.startsWith("Snipe"));
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 5 });
    await call("POST", "/api/dev/airdrop", { walletIds: holders.map((h) => h.id), sol: 2 });
    imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    expect((await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).status).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  it("respeta la espera de cada wallet, en el orden del plan, y la vista muestra cuándo salió cada compra", async () => {
    const id = await launch(cfg("pro", [1000, 0, 2000]));
    const v = await ctx.launches.waitIdle(id, 30_000);
    expect(v.status).toBe("DONE");
    const buys = v.buys as Buy[];
    expect(buys.map((b) => b.status)).toEqual(["OK", "OK", "OK"]);
    expect(buys.map((b) => b.delayMs)).toEqual([1000, 0, 2000]);
    const t = buys.map((b) => b.sentAfterMs!);
    expect(t.every((x) => typeof x === "number")).toBe(true);
    expect(t[0]).toBeGreaterThanOrEqual(1000); // 1 s tras la creación
    expect(t[1]).toBeGreaterThanOrEqual(t[0]); // sin espera: justo después de la primera
    expect(t[2] - t[1]).toBeGreaterThanOrEqual(2000); // 2 s tras la segunda
  }, 40_000);

  it("en Quick la espera se ignora", async () => {
    const id = await launch(cfg("quick", [5000, 5000]));
    const started = Date.now();
    const v = await ctx.launches.waitIdle(id, 30_000);
    expect(v.status).toBe("DONE");
    expect((v.buys as Buy[]).map((b) => b.delayMs)).toEqual([0, 0]);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 40_000);

  it("bloquear durante la espera pausa el lanzamiento sin enviar la compra pendiente", async () => {
    const id = await launch(cfg("pro", [0, 10_000]));
    for (let i = 0; i < 100 && ((ctx.launches.view(id).buys as Buy[])[0]?.status ?? "PENDING") === "PENDING"; i++) await sleep(50);
    await sleep(300);
    await call("POST", "/api/vault/lock");
    const v = await ctx.launches.waitIdle(id, 5_000);
    expect(v.status).toBe("PAUSED");
    expect((v.buys as Buy[]).map((b) => b.status)).toEqual(["OK", "PENDING"]);
    await call("POST", "/api/vault/unlock", { password: PW });
  }, 40_000);

  it("la espera va de 0 a 10.000 ms (10 s), en milisegundos enteros", async () => {
    for (const d of [-1, 10_001, 1.5]) expect((await call("POST", "/api/launches/preflight", cfg("pro", [d]))).status, String(d)).toBe(400);
  });
});
