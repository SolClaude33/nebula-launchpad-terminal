// F2 · bloque 5: preset Helius Developer y Jito como vía de envío (REQ-SET-001, NFR-TX-003, REQ-COST-001).
// - Unidad: la propina va dentro de la misma tx, la cuenta de propina nunca sale de una tabla de direcciones, el
//   Block Engine recibe los MISMOS bytes en base64, un fallo de Jito no cambia el resultado y en `test` no se llama.
// - Recorrido (mock y, con NEBULA_CHAIN_TESTS=1, Surfpool): la propina se ve en la vista previa y en el dry-run,
//   queda en la tabla tx y el P&L la resta aparte sin confundirla con rent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { RPC_PRESETS } from "@nebula/shared";
import { openDb } from "../src/db";
import { SolanaSender } from "../src/chain/sender";
import { JITO_OFF, JITO_TIP_ACCOUNTS, MAX_TX_BYTES, tipAccountFor, tipFor, type JitoConfig } from "../src/chain/jito";
import type { RpcPool } from "../src/chain/rpc";
import type { PreparedTx } from "../src/chain/types";
import { b58encode } from "../src/base58";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, makeApp, tmpDir } from "./helpers";

const TIP = 1_000_000n; // 0,001 SOL
const LIVE: JitoConfig = { enabled: true, tipLamports: TIP, endpoint: "https://ny.mainnet.block-engine.jito.wtf", simulated: false };
const TIP_SET = new Set<string>(JITO_TIP_ACCOUNTS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** RPC simulado: guarda los bytes que se envían; confirma al instante. */
function stubPool() {
  const sent: Uint8Array[] = [];
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: b58encode(randomBytes(32)), lastValidBlockHeight: 1000 }),
    simulateTransaction: async () => ({ value: { err: null, logs: [], unitsConsumed: 1000 } }),
    sendRawTransaction: async (raw: Uint8Array) => (sent.push(raw), "sig"),
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 500,
  };
  const pool = { run: <T>(fn: (c: never) => Promise<T>) => fn(conn as never), tryRun: <T>(fn: (c: never) => Promise<T>) => fn(conn as never) } as unknown as RpcPool;
  return { pool, sent };
}

/** fetch simulado del Block Engine. */
function stubFetch(reply: (body: any) => { status: number; json: unknown } = () => ({ status: 200, json: { jsonrpc: "2.0", id: 1, result: "sig" } })) {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const r = reply(body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const payerKp = Keypair.generate();
const payer = payerKp.publicKey.toBase58();
const sign = () => new Uint8Array(64);
const someIx = (dataLen = 8) => new TransactionInstruction({ programId: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), keys: [{ pubkey: payerKp.publicKey, isSigner: true, isWritable: true }, { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }], data: Buffer.alloc(dataLen, 7) });
const txOf = (kind: PreparedTx["kind"], ixs: TransactionInstruction[] = [someIx()], extra: Partial<PreparedTx> = {}): PreparedTx => ({ kind, payer, signers: [payer], payload: { instructions: ixs }, ...extra });

/** Instrucciones de transferencia del System Program a una cuenta de propina dentro de una tx serializada. */
function tipsIn(raw: Uint8Array, alt?: AddressLookupTableAccount) {
  const vtx = VersionedTransaction.deserialize(raw);
  const keys = vtx.message.getAccountKeys(alt ? { addressLookupTableAccounts: [alt] } : undefined);
  const out: { to: string; lamports: bigint; staticTo: boolean }[] = [];
  for (const ix of vtx.message.compiledInstructions) {
    if (!keys.get(ix.programIdIndex)!.equals(SystemProgram.programId)) continue;
    const d = Buffer.from(ix.data);
    if (d.readUInt32LE(0) !== 2) continue; // Transfer
    const to = keys.get(ix.accountKeyIndexes[1])!.toBase58();
    if (!TIP_SET.has(to)) continue;
    out.push({ to, lamports: d.readBigUInt64LE(4), staticTo: ix.accountKeyIndexes[1] < vtx.message.staticAccountKeys.length });
  }
  return out;
}

describe("Preset Helius Developer (F2 · bloque 5)", () => {
  it("40 peticiones/s y 5 envíos/s; /chain/status lo expone y el aviso del paso 3 da 200 ms", async () => {
    expect(RPC_PRESETS.heliusDeveloper).toMatchObject({ rpcMaxRps: 40, rpcSendPerSec: 5 });
    expect(RPC_PRESETS.heliusFree).toMatchObject({ rpcMaxRps: 8, rpcSendPerSec: 1 });
    const { app, call } = await makeApp();
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const p = RPC_PRESETS.heliusDeveloper;
    const r = await call("PUT", "/api/settings", { rpcMaxRps: p.rpcMaxRps, rpcSendPerSec: p.rpcSendPerSec });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const st = (await call("GET", "/api/chain/status")).json;
    expect(st.sendPerSec).toBe(5);
    // misma cuenta que step-funding.tsx: Math.ceil(1000 / sendPerSec)
    expect(Math.ceil(1000 / st.sendPerSec)).toBe(200);
    await app.close();
  });
});

describe("Jito · sender (unidad)", () => {
  it("compra: la propina va al final de la MISMA tx, a una cuenta oficial elegida sin azar, y se registra antes de emitir", async () => {
    const db = openDb(tmpDir());
    const { pool, sent } = stubPool();
    const { f, calls } = stubFetch();
    const s = new SolanaSender(pool, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, jito: () => LIVE, fetch: f });
    const r = await s.send(txOf("buy"), { idempotencyKey: "trade:o1:w1" });
    expect(r).toMatchObject({ status: "confirmed", tipLamports: TIP });
    expect(sent).toHaveLength(1);
    const tips = tipsIn(sent[0]);
    expect(tips).toEqual([{ to: tipAccountFor("trade:o1:w1").toBase58(), lamports: TIP, staticTo: true }]);
    // la última instrucción es la propina (si la operación falla, no se paga)
    const vtx = VersionedTransaction.deserialize(sent[0]);
    const last = vtx.message.compiledInstructions.at(-1)!;
    expect(vtx.message.staticAccountKeys[last.programIdIndex].equals(SystemProgram.programId)).toBe(true);
    // determinista: la misma key da siempre la misma cuenta
    expect(tipAccountFor("trade:o1:w1").toBase58()).toBe(tipAccountFor("trade:o1:w1").toBase58());
    expect((db.prepare("SELECT tip_lamports FROM tx WHERE idempotency_key = 'trade:o1:w1'").get() as { tip_lamports: number }).tip_lamports).toBe(Number(TIP));
    // Block Engine: sendTransaction con los MISMOS bytes en base64
    await sleep(20);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions");
    expect(calls[0].body).toMatchObject({ jsonrpc: "2.0", method: "sendTransaction", params: [Buffer.from(sent[0]).toString("base64"), { encoding: "base64" }] });
    expect(s.jito()!.stats).toMatchObject({ sent: 1, failed: 0 });
    // reintentar con la misma key no vuelve a emitir y devuelve la propina guardada
    expect(await s.send(txOf("buy"), { idempotencyKey: "trade:o1:w1" })).toMatchObject({ status: "confirmed", reused: true, tipLamports: TIP });
    expect(sent).toHaveLength(1);
    db.close();
  });

  it("un fallo del Block Engine (429) no cambia el resultado: el RPC normal es la fuente de verdad", async () => {
    const db = openDb(tmpDir());
    const { pool, sent } = stubPool();
    const { f, calls } = stubFetch(() => ({ status: 429, json: { jsonrpc: "2.0", id: 1, error: { code: -32097, message: "Rate limit exceeded" } } }));
    const s = new SolanaSender(pool, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, jito: () => LIVE, fetch: f });
    expect(await s.send(txOf("sell"), { idempotencyKey: "k-429" })).toMatchObject({ status: "confirmed", tipLamports: TIP });
    await sleep(20);
    expect(calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(s.jito()!.stats).toMatchObject({ sent: 0, failed: 1, lastError: "Rate limit exceeded" });
    db.close();
  });

  it("reclamos, transferencias y quemas no llevan propina; con Jito apagado, nada cambia", async () => {
    for (const k of ["claim", "transfer", "burn", "token-transfer"] as const) expect(tipFor(k, LIVE)).toBe(0n);
    expect(tipFor("buy", JITO_OFF)).toBe(0n);
    expect(tipFor("buy", { ...LIVE, tipLamports: 999n })).toBe(0n); // por debajo del mínimo de Jito
    const db = openDb(tmpDir());
    const { pool, sent } = stubPool();
    const { f, calls } = stubFetch();
    const s = new SolanaSender(pool, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, jito: () => LIVE, fetch: f });
    expect(await s.send(txOf("claim"), { idempotencyKey: "claim-1" })).toMatchObject({ status: "confirmed", tipLamports: 0n });
    const off = new SolanaSender(pool, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, fetch: f });
    expect(await off.send(txOf("buy"), { idempotencyKey: "buy-off" })).toMatchObject({ status: "confirmed", tipLamports: 0n });
    expect(sent.map((raw) => tipsIn(raw).length)).toEqual([0, 0]);
    await sleep(20);
    expect(calls).toHaveLength(0);
    db.close();
  });

  it("perfil de pruebas (simulado): la propina va en la tx, pero nunca se llama al Block Engine", async () => {
    const db = openDb(tmpDir());
    const { pool, sent } = stubPool();
    const { f, calls } = stubFetch();
    const s = new SolanaSender(pool, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, jito: () => ({ ...LIVE, simulated: true }), fetch: f });
    expect(await s.send(txOf("buy"), { idempotencyKey: "sim-1" })).toMatchObject({ status: "confirmed", tipLamports: TIP });
    expect(tipsIn(sent[0])).toHaveLength(1);
    await sleep(20);
    expect(calls).toHaveLength(0);
    expect(s.jito()).toBeNull();
    expect(s.jitoSimulated.count).toBe(1);
    db.close();
  });

  it("la cuenta de propina nunca se carga de una tabla de direcciones, aunque la tabla tenga el System Program", async () => {
    const db = openDb(tmpDir());
    const { pool, sent } = stubPool();
    const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [SystemProgram.programId, Keypair.generate().publicKey] } });
    const s = new SolanaSender(pool, () => db, sign, { computeUnitLimit: 400_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, jito: () => ({ ...LIVE, simulated: true }) });
    await s.send(txOf("create", [someIx()], { lookupTables: [alt] }), { idempotencyKey: "launch:x:create" });
    const t = tipsIn(sent[0], alt);
    expect(t).toHaveLength(1);
    expect(t[0].staticTo).toBe(true);
    db.close();
  });

  it("creación al límite de 1.232 bytes: si la propina no cabe, esa tx sale sin propina y sin Block Engine (nunca se parte)", async () => {
    const db = openDb(tmpDir());
    const { pool, sent } = stubPool();
    const { f, calls } = stubFetch();
    const s = new SolanaSender(pool, () => db, sign, { computeUnitLimit: 400_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, jito: () => LIVE, fetch: f });
    // tamaño base (con propina) con 0 bytes de datos → relleno hasta dejar ~20 bytes libres sin propina (ocupa ~81)
    await s.send(txOf("create", [someIx(0)]), { idempotencyKey: "probe" });
    expect(tipsIn(sent[0])).toHaveLength(1);
    const noTipBase = sent[0].length - 81;
    const fill = MAX_TX_BYTES - noTipBase - 20;
    const sim = await s.send(txOf("create", [someIx(fill)]), { idempotencyKey: "launch:big:pf", simulateOnly: true });
    expect(sim).toMatchObject({ status: "simulated", tipLamports: 0n });
    const r = await s.send(txOf("create", [someIx(fill)]), { idempotencyKey: "launch:big:create" });
    expect(r).toMatchObject({ status: "confirmed", tipLamports: 0n });
    const raw = sent.at(-1)!;
    expect(raw.length).toBeLessThanOrEqual(MAX_TX_BYTES);
    expect(tipsIn(raw)).toHaveLength(0);
    // una sola tx con la creación entera: ni tx de propina aparte ni bundle
    expect(sent).toHaveLength(2);
    await sleep(20);
    expect(calls.map((c) => c.body.params[0])).not.toContain(Buffer.from(raw).toString("base64"));
    expect((db.prepare("SELECT tip_lamports FROM tx WHERE idempotency_key = 'launch:big:create'").get() as { tip_lamports: number }).tip_lamports).toBe(0);
    db.close();
  });
});

describe("Ajustes de Jito", () => {
  it("activar Jito exige una propina ≥ 1.000 lamports y un Block Engine https; /chain/status la expone como simulada en pruebas", async () => {
    const { app, call } = await makeApp();
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const off = (await call("GET", "/api/settings")).json;
    expect(off).toMatchObject({ jitoEnabled: false, jitoTipSol: 0.001 });
    expect((await call("GET", "/api/chain/status")).json.jito).toEqual({ enabled: false, tipLamports: "0", simulated: true });
    expect((await call("PUT", "/api/settings", { jitoEnabled: true, jitoTipSol: 0.0000005 })).status).toBe(400);
    expect((await call("PUT", "/api/settings", { jitoEndpoint: "http://mainnet.block-engine.jito.wtf" })).status).toBe(400);
    const r = await call("PUT", "/api/settings", { jitoEnabled: true, jitoTipSol: 0.002, jitoEndpoint: "https://frankfurt.mainnet.block-engine.jito.wtf" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ jitoEnabled: true, jitoTipSol: 0.002, jitoEndpoint: "https://frankfurt.mainnet.block-engine.jito.wtf" });
    expect((await call("GET", "/api/chain/status")).json.jito).toEqual({ enabled: true, tipLamports: "2000000", simulated: true });
    await app.close();
  });
});

const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];
const SOL = 1_000_000_000n;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe.each(backends)("Jito · recorrido completo · %s", (backend) => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  type W = { id: string; address: string; label: string };
  let dev: W;
  let holder: W;
  let mint = "";
  let initial = 0n;
  let launch: { draftId: string; preflight: any } = { draftId: "", preflight: null };

  const call = async (method: "GET" | "POST" | "PUT", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
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
  const all = () => [dev, holder].map((w) => w.address);
  const total = async () => [...(await ctx.chain.get().reader.balances(all())).values()].reduce((a, b) => a + b, 0n);

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: backend === "mock" ? "mock" : "rpc" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    expect((await call("PUT", "/api/settings", { jitoEnabled: true, jitoTipSol: 0.001 })).status).toBe(200);
    dev = (await call("POST", "/api/wallets", { count: 1, role: "dev", labelPrefix: "Dev" })).json.wallets.find((w: W) => w.label.startsWith("Dev"));
    holder = (await call("POST", "/api/wallets", { count: 1, role: "holder", labelPrefix: "Holder" })).json.wallets.find((w: W) => w.label.startsWith("Holder"));
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 3 });
    await call("POST", "/api/dev/airdrop", { walletIds: [holder.id], sol: 1 });
    initial = await total();
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    expect((await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).status).toBe(200);
    const draftId = `d-${randomUUID()}`;
    // nombre y símbolo al máximo: la creación con propina tiene que seguir cabiendo con la URI del perfil
    const cfg = { draftId, name: "Jito Tip Size Check Max Name 32", symbol: "JITOTIPMAX", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: ((SOL * 2n) / 10n).toString(), mode: "quick", holders: [{ walletId: holder.id, lamports: (SOL / 5n).toString() }], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true };
    const pf = (await call("POST", "/api/launches/preflight", cfg)).json;
    expect(pf.preflight.ok, JSON.stringify(pf.preflight)).toBe(true);
    launch = { draftId, preflight: pf.preflight };
  }, 240_000);
  afterAll(async () => {
    await app?.close();
  });

  it("el dry-run dice que la creación lleva la propina; cambiar la propina invalida el dry-run", async () => {
    const create = launch.preflight.checks.find((c: { label: string }) => c.label.startsWith("Crear token"));
    expect(create.note).toMatch(/Lleva la propina de Jito \(0,001 SOL\)/);
    // otra propina tras el dry-run en verde → no se lanza con costes que no se vieron
    await call("PUT", "/api/settings", { jitoTipSol: 0.0015 });
    const bad = await call("POST", `/api/launches/${launch.draftId}/execute`);
    expect(bad.status).toBe(409);
    expect(bad.json.message).toMatch(/propina de Jito/);
    await call("PUT", "/api/settings", { jitoTipSol: 0.001 });
    expect((await call("POST", `/api/launches/${launch.draftId}/execute`)).status).toBe(200);
    const v = await ctx.launches.waitIdle(launch.draftId);
    expect(v.status).toBe("DONE");
    mint = v.mint;
    const rows = ctx.db().prepare("SELECT idempotency_key AS k, kind, tip_lamports AS tip FROM tx WHERE status = 'CONFIRMED' AND mint = ?").all(mint) as { k: string; kind: string; tip: number }[];
    expect(rows.find((r) => r.kind === "create")?.tip).toBe(Number(TIP));
    expect(rows.filter((r) => r.kind === "buy").map((r) => r.tip)).toEqual([Number(TIP)]);
  }, 240_000);

  it("REQ-COST-001: la vista previa de compra y venta suma la propina; el MAX la reserva", async () => {
    const qb = (await call("POST", "/api/trade/quote", { mint, side: "buy", walletIds: [holder.id], lamportsEach: (SOL / 20n).toString(), slippagePct: 15 })).json;
    expect(qb.tipPerTx).toBe(TIP.toString());
    expect(qb.costs.jito).toBe(TIP.toString());
    expect(BigInt(qb.costs.total)).toBe(BigInt(qb.costs.volume) + BigInt(qb.feePerTx) + TIP + BigInt(qb.costs.rent));
    const qs = (await call("POST", "/api/trade/quote", { mint, side: "sell", walletIds: [dev.id, holder.id], pct: 100, slippagePct: 5 })).json;
    expect(qs.costs.jito).toBe((TIP * 2n).toString());
    expect(BigInt(qs.costs.total)).toBe((BigInt(qs.feePerTx) + TIP) * 2n);
  }, 120_000);

  it("REQ-DASH-001: tras comprar y vender todo, el P&L resta las propinas aparte y el rent no las incluye", async () => {
    expect((await order({ side: "buy", walletIds: [holder.id], lamportsEach: (SOL / 20n).toString() })).status).toBe("COMPLETED");
    const sell = await order({ side: "sell", walletIds: [dev.id, holder.id], pct: 100, slippagePct: 5 });
    expect(sell.status, JSON.stringify(sell.items)).toBe("COMPLETED");
    let d = (await call("GET", "/api/dashboard?period=all")).json;
    for (let i = 0; i < 40 && d.indexing.pending > 0; i++) await sleep(500), (d = (await call("GET", "/api/dashboard?period=all")).json);
    expect(d.indexing.pending).toBe(0);
    const txs = ctx.db().prepare("SELECT kind, mint, chain_fee, tip_lamports AS tip, own_delta FROM tx WHERE status = 'CONFIRMED'").all() as { kind: string; mint: string | null; chain_fee: number; tip: number; own_delta: number }[];
    const tips = txs.reduce((a, t) => a + t.tip, 0);
    // creación + compra del plan + 2.ª compra + 2 ventas = 5 propinas
    expect(tips).toBe(Number(TIP) * 5);
    expect(d.totals.jitoLamports).toBe(tips);
    expect(txs.reduce((a, t) => a + BigInt(t.own_delta), 0n)).toBe((await total()) - initial);
    const fees = txs.reduce((a, t) => a + t.chain_fee, 0);
    expect(Math.abs(d.totals.pnlLamports - (d.totals.sellsLamports - d.totals.buysLamports - fees - tips))).toBeLessThanOrEqual(2);
    // Δ SOL del token = P&L + fees de fuera del token − rent: con la propina contada aparte, el rent sigue cuadrando
    const mintDelta = txs.filter((t) => t.mint === mint).reduce((a, t) => a + t.own_delta, 0);
    const otherFees = txs.filter((t) => t.mint !== mint).reduce((a, t) => a + t.chain_fee + t.tip, 0);
    expect(Math.abs(d.totals.pnlLamports + otherFees - d.totals.rentLamports - mintDelta)).toBeLessThanOrEqual(2);
    expect(d.totals.rentLamports).toBeLessThan(Number(SOL / 10n));
  }, 300_000);
});
