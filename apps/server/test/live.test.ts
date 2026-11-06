// Bloque 5 · Live Workspace real (REQ-LIVE-001/002, REQ-CORE-001 parseEvents, E2E-12, REQ-REW-001/002, REQ-COST-002)
// contra el mock y (NEBULA_CHAIN_TESTS=1) Surfpool. Las dos deben comportarse igual.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildApp } from "../src/app";
import { eventDisc } from "../src/chain/events";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];
const SOL = 1_000_000_000n;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("parseEvents · discriminadores", () => {
  it("coinciden con los del IDL de Pump.fun (TradeEvent, CompleteEvent, migración)", () => {
    expect([...eventDisc("TradeEvent")]).toEqual([189, 219, 127, 211, 78, 230, 97, 238]);
    expect([...eventDisc("CompleteEvent")]).toEqual([95, 114, 97, 156, 212, 46, 152, 8]);
    expect([...eventDisc("CompletePumpAmmMigrationEvent")]).toEqual([189, 233, 93, 185, 92, 148, 234, 148]);
  });
});

describe.each(backends)("Live Workspace real · %s", (backend) => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  type W = { id: string; address: string; label: string };
  let dev: W, whale: W, poor: W, maxer: W, maxer2: W;
  let holders: W[] = [];
  let mint = "";

  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  const make = async (prefix: string, count = 1, role?: string) => {
    const r = await call("POST", "/api/wallets", { count, labelPrefix: prefix, ...(role ? { role } : {}) });
    return (r.json.wallets as W[]).filter((w) => w.label.startsWith(prefix));
  };
  const order = async (body: Record<string, unknown>) => {
    const id = randomUUID();
    const r = await call("POST", "/api/trade", { id, mint, slippagePct: 15, mode: "parallel", ...body });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (let i = 0; i < 1200; i++) {
      const v = (await call("GET", `/api/trade/${id}`)).json;
      if (v.status !== "RUNNING") return v;
      await sleep(100);
    }
    throw new Error("La orden no terminó");
  };
  const tokens = (a: string) => ctx.chain.get().reader.tokenBalance(mint, a);
  const sol = async (a: string) => (await ctx.chain.get().reader.balances([a])).get(a)!;

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: backend === "mock" ? "mock" : "rpc" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    [dev] = await make("Dev", 1, "dev");
    holders = await make("Holder", 3, "holder");
    [whale] = await make("Ballena");
    [poor] = await make("Pobre");
    [maxer] = await make("Max");
    [maxer2] = await make("Segundo");
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 3 });
    await call("POST", "/api/dev/airdrop", { walletIds: holders.map((h) => h.id), sol: 1 });
    await call("POST", "/api/dev/airdrop", { walletIds: [whale.id], sol: 100 });
    await call("POST", "/api/dev/airdrop", { walletIds: [maxer.id, maxer2.id], sol: 0.5 });
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    expect((await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).status).toBe(200);
    const draftId = `d-${randomUUID()}`;
    const cfg = { draftId, name: "Órbita Live", symbol: "ORBL", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: (SOL / 2n).toString(), mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true };
    const pf = (await call("POST", "/api/launches/preflight", cfg)).json;
    expect(pf.preflight.ok, JSON.stringify(pf.preflight)).toBe(true);
    await call("POST", `/api/launches/${draftId}/execute`);
    const v = await ctx.launches.waitIdle(draftId);
    expect(v.status).toBe("DONE");
    mint = v.mint;
  }, 240_000);
  afterAll(async () => {
    await app?.close();
  });

  it("REQ-LIVE-001 · curva real: market cap, progreso de graduación, nombre y el dev buy como trade propio", async () => {
    let s = (await call("GET", `/api/live/${mint}`)).json;
    for (let i = 0; i < 50 && s.trades.length === 0; i++) (await sleep(100), (s = (await call("GET", `/api/live/${mint}`)).json));
    expect(s.info.venue).toBe("curve");
    expect(BigInt(s.info.marketCapLamports)).toBeGreaterThan(0n);
    expect(s.info.graduationPct).toBeGreaterThan(0);
    expect(s.info.graduationPct).toBeLessThan(100);
    expect(BigInt(s.info.graduationMcLamports)).toBeGreaterThan(BigInt(s.info.marketCapLamports));
    expect(s.token).toMatchObject({ name: "Órbita Live", symbol: "ORBL", own: true });
    expect(s.solUsd?.usd).toBeGreaterThan(0);
    expect(s.trades).toHaveLength(1);
    expect(s.trades[0]).toMatchObject({ side: "buy", venue: "curve", user: dev.address, own: { id: dev.id } });
    // lo gastado por el dev buy incluye las fees del pad: ≈ 0,5 SOL
    expect(Number(s.trades[0].lamports) / 1e9).toBeCloseTo(0.5, 2);
    expect(BigInt(s.trades[0].tokens)).toBe(await tokens(dev.address));
  });

  it("REQ-LIVE-001 · un trade confirmado aparece en el endpoint en vivo en ≤ 2 s", async () => {
    const first = (await call("GET", `/api/live/${mint}`)).json;
    const chain = ctx.chain.get();
    const tx = await chain.adapter.buildBuyTx({ mint, user: holders[2].address, lamports: SOL / 20n, slippagePct: 15 });
    const res = await chain.sender.send(tx, { idempotencyKey: `t-${randomUUID()}` });
    expect(res.status).toBe("confirmed");
    const t0 = Date.now();
    let seen = false;
    while (Date.now() - t0 < 2000) {
      const s = (await call("GET", `/api/live/${mint}?after=${first.cursor}`)).json;
      if (s.trades.some((t: { signature: string }) => t.signature === (res as { signature: string }).signature)) {
        seen = true;
        break;
      }
      await sleep(100);
    }
    expect(seen, `no llegó en ${Date.now() - t0} ms`).toBe(true);
  });

  it("REQ-LIVE-002 · ticket: compra desde varias wallets con resultado por wallet; un doble envío es una sola orden", async () => {
    const id = randomUUID();
    const body = { id, mint, side: "buy", walletIds: [...holders.slice(0, 2), poor].map((w) => w.id), lamportsEach: (SOL / 10n).toString(), slippagePct: 15, mode: "staggered" };
    const [a, b] = await Promise.all([call("POST", "/api/trade", body), call("POST", "/api/trade", body)]);
    expect(a.json.id).toBe(b.json.id);
    const v = await ctx.trading.waitIdle(id);
    expect(v.status).toBe("PARTIAL");
    const st = Object.fromEntries((v.items as { walletId: string; status: string; reason: string; result: string }[]).map((i) => [i.walletId, i]));
    expect(st[holders[0].id].status).toBe("OK");
    expect(st[holders[1].id].status).toBe("OK");
    expect(st[poor.id]).toMatchObject({ status: "SKIPPED" });
    expect(st[poor.id].reason).toMatch(/Saldo insuficiente/);
    // el resultado es lo realmente recibido en cadena
    expect(BigInt(st[holders[0].id].result)).toBe(await tokens(holders[0].address));
  });

  it("REQ-LIVE-001 · holders: wallets propias marcadas, la curva etiquetada y cantidades reales", async () => {
    const h = (await call("GET", `/api/live/${mint}/holders`)).json;
    const byOwner = new Map((h.items as { owner: string; amount: string; own: { id: string } | null; system: string | null }[]).map((i) => [i.owner, i]));
    expect(byOwner.get(dev.address)).toMatchObject({ own: { id: dev.id } });
    expect(BigInt(byOwner.get(holders[0].address)!.amount)).toBe(await tokens(holders[0].address));
    expect(h.items.find((i: { system: string | null }) => i.system === "Bonding curve")).toBeTruthy();
    expect(h.count).toBe(4); // dev + 3 holders, sin contar la curva
  });

  it("REQ-LIVE-001 · posición agregada con coste base de los trades propios", async () => {
    const p = (await call("GET", `/api/live/${mint}/position`)).json;
    const dv = p.items.find((i: { walletId: string }) => i.walletId === dev.id);
    expect(BigInt(dv.tokens)).toBe(await tokens(dev.address));
    expect(dv.costLamports / 1e9).toBeCloseTo(0.5, 2);
    expect(dv.valueLamports).toBeGreaterThan(0);
    expect(BigInt(p.total.tokens)).toBeGreaterThan(BigInt(dv.tokens));
  });

  it("REQ-COST-001/002 · la vista previa desglosa costes y comprar con MAX no falla por fees ni rent", async () => {
    const q = (await call("POST", "/api/trade/quote", { mint, side: "buy", walletIds: [maxer.id], lamportsEach: "1000000", slippagePct: 15 })).json;
    // primera compra: cuenta de token (y en la cadena real, también la cuenta de volumen del programa)
    expect(BigInt(q.costs.rent)).toBeGreaterThanOrEqual(BigInt(q.rentPerAccount));
    expect(BigInt(q.costs.padFee)).toBeGreaterThanOrEqual(0n);
    const max = BigInt(q.maxBuyPerWallet);
    expect(max).toBeGreaterThan(0n);
    expect(max).toBeLessThan(await sol(maxer.address));
    const v = await order({ side: "buy", walletIds: [maxer.id], lamportsEach: max.toString() });
    expect(v.items[0].status, JSON.stringify(v.items[0])).toBe("OK");
  });

  it("REQ-LIVE-002 · venta del 50 % de la posición en paralelo", async () => {
    const before = await Promise.all(holders.slice(0, 2).map((h) => tokens(h.address)));
    const v = await order({ side: "sell", walletIds: holders.slice(0, 2).map((h) => h.id), pct: 50, slippagePct: 5 });
    expect(v.status).toBe("COMPLETED");
    for (let i = 0; i < 2; i++) expect(await tokens(holders[i].address)).toBe(before[i] - before[i] / 2n);
    // recibe SOL neto positivo
    expect(BigInt(v.items[0].result)).toBeGreaterThan(0n);
  });

  it.runIf(backend === "mock")("un envío pendiente deja la wallet pendiente y la orden en pausa; al reanudar termina sin duplicar", async () => {
    ctx.chain.get().ledger!.failures.push("RPC_DOWN");
    const id = randomUUID();
    await call("POST", "/api/trade", { id, mint, side: "buy", walletIds: [holders[2].id], lamportsEach: (SOL / 50n).toString(), slippagePct: 15 });
    let v = await ctx.trading.waitIdle(id);
    expect(v.status).toBe("PAUSED");
    expect(v.items[0].status).toBe("PENDING");
    expect((await call("GET", "/api/vault/status")).json.paused.some((p: { id: string }) => p.id === id)).toBe(true);
    await call("POST", `/api/trade/${id}/resume`);
    v = await ctx.trading.waitIdle(id);
    expect(v.status).toBe("COMPLETED");
  });

  it("E2E-12 · graduar, migrar a PumpSwap y operar contra el pool desde el mismo flujo", async () => {
    const g = await order({ side: "buy", walletIds: [whale.id], lamportsEach: (90n * SOL).toString(), slippagePct: 5 });
    expect(g.items[0].status, JSON.stringify(g.items[0])).toBe("OK");
    let s = (await call("GET", `/api/live/${mint}`)).json;
    expect(s.info.venue).toBe("migrating");
    expect(s.info.graduationPct).toBe(100);
    // sin pool, la orden se rechaza con un motivo claro (no «CURVE_COMPLETE»)
    const blocked = await call("POST", "/api/trade", { id: randomUUID(), mint, side: "buy", walletIds: [holders[2].id], lamportsEach: "10000000", slippagePct: 5 });
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toMatch(/migración/);
    const m = await call("POST", "/api/dev/migrate", { mint, payerWalletId: whale.id });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    s = (await call("GET", `/api/live/${mint}`)).json;
    expect(s.info.venue).toBe("pumpswap");
    expect(s.info.pool).toBeTruthy();

    // MAX en PumpSwap con una wallet nueva: reserva la cuenta de token, la de volumen y la WSOL temporal
    const mq = (await call("POST", "/api/trade/quote", { mint, side: "buy", walletIds: [maxer2.id], lamportsEach: "1000000", slippagePct: 5 })).json;
    const mv = await order({ side: "buy", walletIds: [maxer2.id], lamportsEach: mq.maxBuyPerWallet, slippagePct: 5 });
    expect(mv.items[0].status, JSON.stringify(mv.items[0])).toBe("OK");

    const before = await tokens(holders[2].address);
    const q = (await call("POST", "/api/trade/quote", { mint, side: "buy", walletIds: [holders[2].id], lamportsEach: (SOL / 10n).toString(), slippagePct: 5 })).json;
    expect(q.venue).toBe("pumpswap");
    const b = await order({ side: "buy", walletIds: [holders[2].id], lamportsEach: (SOL / 10n).toString(), slippagePct: 5 });
    expect(b.items[0].status, JSON.stringify(b.items[0])).toBe("OK");
    expect((await tokens(holders[2].address)) - before).toBeGreaterThan(0n);
    const solBefore = await sol(holders[2].address);
    const sq = (await call("POST", "/api/trade/quote", { mint, side: "sell", walletIds: [holders[2].id], pct: 100, slippagePct: 5 })).json;
    const sv = await order({ side: "sell", walletIds: [holders[2].id], pct: 100, slippagePct: 5 });
    expect(sv.items[0].status, JSON.stringify(sv.items[0])).toBe("OK");
    expect(await tokens(holders[2].address)).toBe(0n);
    // recibe al menos el mínimo enviado (menos la fee de red)
    expect((await sol(holders[2].address)) - solBefore).toBeGreaterThanOrEqual(BigInt(sq.items[0].limit) - 2_000_000n);
    if (backend === "surfpool") {
      // la cuenta temporal de WSOL se cierra en la misma tx
      const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(holders[2].address), true);
      expect(await ctx.chain.get().reader.accountExists(wsol.toBase58())).toBe(false);
    }
    // los trades de PumpSwap llegan al Live con su venue, y el market cap del evento cuadra con el pool
    for (let i = 0; i < 30; i++) {
      s = (await call("GET", `/api/live/${mint}`)).json;
      if (s.trades.filter((t: { venue: string }) => t.venue === "pumpswap").length >= 3) break;
      await sleep(100);
    }
    const ps = s.trades.filter((t: { venue: string }) => t.venue === "pumpswap");
    expect(ps.map((t: { side: string }) => t.side)).toEqual(["buy", "buy", "sell"]);
    const last = Number(ps.at(-1).mc);
    expect(Math.abs(last - Number(s.info.marketCapLamports)) / Number(s.info.marketCapLamports)).toBeLessThan(0.005);
  });

  it("REQ-REW-001/002 · comisiones: escanear, confirmar con el neto y reclamar verificado en cadena", async () => {
    const r = await call("GET", "/api/rewards");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const scan = r.json;
    const it0 = scan.items.find((i: { walletId: string }) => i.walletId === dev.id);
    expect(BigInt(it0.claimable)).toBeGreaterThan(0n);
    expect(it0.tokens.map((t: { mint: string }) => t.mint)).toContain(mint);
    const pv = (await call("POST", "/api/rewards/preview", { walletIds: [dev.id, poor.id] })).json;
    expect(pv.status).toBe("PREVIEW");
    expect(pv.items.find((i: { walletId: string }) => i.walletId === poor.id)).toMatchObject({ status: "SKIPPED" });
    const expected = BigInt(pv.items[0].expected);
    const fee = BigInt(pv.items[0].fee);
    expect(BigInt(pv.totals.net)).toBe(expected - fee);
    await call("POST", `/api/rewards/${pv.id}/execute`);
    const v = await ctx.rewards.waitIdle(pv.id);
    expect(v.status).toBe("COMPLETED");
    const done = v.items[0];
    expect(done.status).toBe("OK");
    // lo recibido es exactamente lo reclamable menos la fee mostrada, y la bóveda queda vacía
    expect(BigInt(done.received!)).toBe(expected - fee);
    expect(done.leftAfter).toBe("0");
  });
});
