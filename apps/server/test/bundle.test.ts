// Bundle de lanzamiento (Jito sendBundle, máx. 5 tx) separado del snipe.
// Nada de esto llama al Block Engine real ni firma con claves de una bóveda de usuario.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { openDb } from "../src/db";
import { JitoClient, JITO_MAX_BUNDLE_TXS, JITO_TIP_ACCOUNTS, tipAccountFor } from "../src/chain/jito";
import { SolanaSender } from "../src/chain/sender";
import { createMockEnv } from "../src/chain/mock";
import type { RpcPool } from "../src/chain/rpc";
import type { PreparedTx } from "../src/chain/types";
import { b58encode } from "../src/base58";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const TIP = 1_000_000n;
const SOL = 1_000_000_000n;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function stubFetch(handler: (body: { method?: string; params?: unknown[] }) => { status?: number; json: unknown } | "throw") {
  const calls: { url: string; body: { method?: string; params?: unknown[] } }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method?: string; params?: unknown[] };
    calls.push({ url, body });
    const r = handler(body);
    if (r === "throw") throw new Error("socket hang up");
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("JitoClient · sendBundle documentado", () => {
  it("POST /api/v1/bundles con sendBundle y base64, y no inventa un bundle_id", async () => {
    const { f, calls } = stubFetch((body) => (body.method === "sendBundle" ? { json: { jsonrpc: "2.0", id: 1, result: "bundle-id-real" } } : { json: { jsonrpc: "2.0", id: 1, result: { value: [{ status: "Landed" }] } } }));
    const c = new JitoClient("https://ny.mainnet.block-engine.jito.wtf/", f, 0);
    const sent = await c.sendBundle([Uint8Array.from([1, 2]), Uint8Array.from([3])]);
    expect(sent).toEqual({ ok: true, bundleId: "bundle-id-real" });
    expect(calls[0].url).toBe("https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles");
    expect(calls[0].body.method).toBe("sendBundle");
    expect(calls[0].body.params).toEqual([[Buffer.from([1, 2]).toString("base64"), Buffer.from([3]).toString("base64")], { encoding: "base64" }]);
    const missing = await new JitoClient("https://ny.mainnet.block-engine.jito.wtf", stubFetch(() => ({ json: { jsonrpc: "2.0", id: 1, result: null } })).f, 0).sendBundle([Uint8Array.from([1])]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/bundle_id/);
  });

  it("rechaza más de 5 transacciones sin llamar a la red", async () => {
    const { f, calls } = stubFetch(() => ({ json: {} }));
    const c = new JitoClient("https://mainnet.block-engine.jito.wtf", f, 0);
    const r = await c.sendBundle(Array.from({ length: JITO_MAX_BUNDLE_TXS + 1 }, () => Uint8Array.from([1])));
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("getInflightBundleStatuses null no es Landed", async () => {
    const { f, calls } = stubFetch(() => ({ json: { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: null } } }));
    const c = new JitoClient("https://frankfurt.mainnet.block-engine.jito.wtf", f, 0);
    expect(await c.inflight("abc")).toEqual({ status: "unknown" });
    expect(calls[0].url).toBe("https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/getInflightBundleStatuses");
    expect(calls[0].body).toMatchObject({ method: "getInflightBundleStatuses", params: [["abc"]] });
  });

  it("un error JSON-RPC no se convierte en éxito", async () => {
    const { f } = stubFetch(() => ({ status: 200, json: { jsonrpc: "2.0", id: 1, error: { message: "bundle contains an expired blockhash" } } }));
    const r = await new JitoClient("https://mainnet.block-engine.jito.wtf", f, 0).sendBundle([Uint8Array.from([1])]);
    expect(r).toMatchObject({ ok: false, transport: false, error: "bundle contains an expired blockhash" });
  });
});

describe("SolanaSender · sendBundle no sale por el RPC", () => {
  const payerKp = Keypair.generate();
  const payer = payerKp.publicKey.toBase58();
  const sign = () => new Uint8Array(64);
  const txOf = (payerKey = payer): PreparedTx => ({
    kind: "buy",
    payer: payerKey,
    signers: [payerKey],
    mint: Keypair.generate().publicKey.toBase58(),
    payload: { instructions: [new TransactionInstruction({ programId: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"), keys: [{ pubkey: new PublicKey(payerKey), isSigner: true, isWritable: true }], data: Buffer.alloc(8) })] },
  });

  function pool(sigs: ("confirmed" | null)[]) {
    const sent: Uint8Array[] = [];
    let n = 0;
    const conn = {
      getLatestBlockhash: async () => ({ blockhash: b58encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 1000 }),
      simulateTransaction: async () => ({ value: { err: null, logs: [], unitsConsumed: 10 } }),
      sendRawTransaction: async (raw: Uint8Array) => (sent.push(raw), "no"),
      getSignatureStatuses: async (xs: string[]) => ({ value: xs.map(() => (sigs[n++] === "confirmed" ? { err: null, confirmationStatus: "confirmed" } : null)) }),
      getBlockHeight: async () => 100,
    };
    return { pool: { run: <T>(fn: (c: never) => Promise<T>) => fn(conn as never) } as unknown as RpcPool, sent, conn };
  }

  it("envía solo sendBundle, propina en la última tx, y Landed sin firmas no es éxito", async () => {
    const db = openDb(tmpDir());
    const { pool: p, sent } = pool([]);
    const { f, calls } = stubFetch((body) => (body.method === "sendBundle" ? { json: { jsonrpc: "2.0", result: "bid-1" } } : { json: { jsonrpc: "2.0", result: { value: [{ status: "Landed" }] } } }));
    const s = new SolanaSender(p, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, jitoRps: 0, jito: () => ({ enabled: true, tipLamports: TIP, endpoint: "https://ny.mainnet.block-engine.jito.wtf", simulated: false }), fetch: f });
    const r = await s.sendBundle([{ tx: txOf(), idempotencyKey: "b:create" }, { tx: txOf(Keypair.generate().publicKey.toBase58()), idempotencyKey: "b:buy" }], { bundleKey: "bundle-1" });
    expect(r.status).toBe("pending");
    if (r.status === "pending") expect(r.message).toMatch(/Landed/);
    expect(sent).toHaveLength(0);
    expect(calls.some((c) => c.body.method === "sendBundle")).toBe(true);
    expect(calls.some((c) => String(c.url).includes("/api/v1/transactions"))).toBe(false);
    const raws = (calls.find((c) => c.body.method === "sendBundle")!.body.params as [string[]])[0].map((b) => Buffer.from(b, "base64"));
    const tipOf = (raw: Buffer) => {
      const vtx = VersionedTransaction.deserialize(raw);
      const keys = vtx.message.getAccountKeys();
      return vtx.message.compiledInstructions.some((ix) => keys.get(ix.programIdIndex)!.equals(SystemProgram.programId) && JITO_TIP_ACCOUNTS.includes(keys.get(ix.accountKeyIndexes[1])!.toBase58() as (typeof JITO_TIP_ACCOUNTS)[number]));
    };
    expect(tipOf(raws[0])).toBe(false);
    expect(tipOf(raws[1])).toBe(true);
    db.close();
  });

  it("un rechazo del Block Engine queda en failed y no toca el RPC", async () => {
    const db = openDb(tmpDir());
    const { pool: p, sent } = pool([]);
    const { f } = stubFetch(() => ({ json: { error: { message: "Rate limit exceeded" } } }));
    const s = new SolanaSender(p, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, jitoRps: 0, jito: () => ({ enabled: true, tipLamports: TIP, endpoint: "https://ny.mainnet.block-engine.jito.wtf", simulated: false }), fetch: f });
    const r = await s.sendBundle([{ tx: txOf(), idempotencyKey: "x" }], { bundleKey: "bundle-err" });
    expect(r).toMatchObject({ status: "failed", message: "Rate limit exceeded" });
    expect(sent).toHaveLength(0);
    db.close();
  });

  it("con Jito simulado no llama a la red ni dice que el bundle salió", async () => {
    const db = openDb(tmpDir());
    const { pool: p, sent } = pool([]);
    const { f, calls } = stubFetch(() => ({ json: { result: "no" } }));
    const s = new SolanaSender(p, () => db, sign, { computeUnitLimit: 200_000, priorityMicroLamports: () => 1, rebroadcastMs: 0, jito: () => ({ enabled: true, tipLamports: TIP, endpoint: "https://ny.mainnet.block-engine.jito.wtf", simulated: true }), fetch: f });
    const r = await s.sendBundle([{ tx: txOf(), idempotencyKey: "s" }], { bundleKey: "sim" });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.message).toMatch(/No se envía el bundle/);
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
    db.close();
  });
});

describe("Lanzamiento · bundle y snipe", () => {
  it("separa los papeles, exige Jito, revierte el bundle entero y no dispara el snipe si falla", async () => {
    const { app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
    const call = async (method: string, url: string, body?: unknown) => {
      const r = await app.inject({ method: method as "POST", url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.statusCode, json: r.json() };
    };
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const dev = (await call("POST", "/api/wallets", { count: 1, role: "dev", labelPrefix: "Dev" })).json.wallets.find((w: { role: string }) => w.role === "dev");
    const ws = (await call("POST", "/api/wallets", { count: 3, role: "holder" })).json.wallets.filter((w: { role: string }) => w.role === "holder");
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id, ...ws.map((w: { id: string }) => w.id)], sol: 2 });
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    expect((await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).status).toBe(200);
    const base = {
      name: "Bundle",
      symbol: "BNDL",
      description: "",
      imageCid,
      links: { x: "", telegram: "", web: "" },
      devWalletId: dev.id,
      devBuyLamports: (SOL / 5n).toString(),
      mode: "quick",
      slippagePct: 15,
      mayhem: false,
      feeMode: "creator",
      feeAck: true,
    };
    const overlap = await call("POST", "/api/launches/preflight", { ...base, draftId: `d-${randomUUID()}`, bundle: [{ walletId: ws[0].id, lamports: "100000000" }], holders: [{ walletId: ws[0].id, lamports: "100000000" }] });
    expect(overlap.status).toBe(400);
    expect(overlap.json.message).toMatch(/bundle y en el snipe/);
    const devIn = await call("POST", "/api/launches/preflight", { ...base, draftId: `d-${randomUUID()}`, bundle: [{ walletId: dev.id, lamports: "100000000" }], holders: [] });
    expect(devIn.status).toBe(400);
    const zero = await call("POST", "/api/launches/preflight", { ...base, draftId: `d-${randomUUID()}`, bundle: [{ walletId: ws[0].id, lamports: "0" }], holders: [] });
    expect(zero.status).toBe(400);
    const tooMany = await call("POST", "/api/launches/preflight", { ...base, draftId: `d-${randomUUID()}`, bundle: [0, 1, 2, 3, 4].map(() => ({ walletId: ws[0].id, lamports: "100000000" })), holders: [] });
    expect(tooMany.status).toBe(400);
    const off = await call("POST", "/api/launches/preflight", { ...base, draftId: `d-${randomUUID()}`, bundle: [{ walletId: ws[0].id, lamports: "100000000" }], holders: [{ walletId: ws[1].id, lamports: "100000000" }] });
    expect(off.status).toBe(200);
    expect(off.json.preflight.ok).toBe(false);
    expect(off.json.preflight.checks.find((c: { label: string }) => c.label.startsWith("Bundle"))).toMatchObject({ ok: false });

    expect((await call("PUT", "/api/settings", { jitoEnabled: true, jitoTipSol: 0.001, jitoEndpoint: "https://mainnet.block-engine.jito.wtf" })).status).toBe(200);
    const draftId = `d-${randomUUID()}`;
    const cfg = { ...base, draftId, bundle: [{ walletId: ws[0].id, lamports: "150000000" }], holders: [{ walletId: ws[1].id, lamports: "150000000", delayMs: 0 }] };
    const pf = await call("POST", "/api/launches/preflight", cfg);
    expect(pf.json.preflight.ok, JSON.stringify(pf.json.preflight)).toBe(true);
    expect(pf.json.preflight.checks.find((c: { label: string }) => c.label.startsWith("Bundle")).note).toMatch(/simulado/);
    ctx.chain.get().ledger!.failBundleAt = 1;
    expect((await call("POST", `/api/launches/${draftId}/execute`)).status).toBe(200);
    let failed;
    for (let i = 0; i < 50; i++) {
      failed = (await call("GET", `/api/launches/${draftId}`)).json;
      if (failed.status === "FAILED" || failed.status === "DONE") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(failed.status).toBe("FAILED");
    expect(failed.bundleResult).toMatchObject({ transport: "simulated", bundleId: null, status: "failed" });
    expect(failed.buys.find((b: { role: string }) => b.role === "bundle").status).toBe("FAILED");
    expect(failed.buys.find((b: { role: string }) => b.role === "snipe").status).toBe("SKIPPED");
    expect(await ctx.chain.get().reader.accountExists(failed.mint)).toBe(false);
    expect(await ctx.chain.get().reader.tokenBalance(failed.mint, dev.address)).toBe(0n);

    const okId = `d-${randomUUID()}`;
    const okCfg = { ...cfg, draftId: okId, symbol: "BND2" };
    expect((await call("POST", "/api/launches/preflight", okCfg)).json.preflight.ok).toBe(true);
    await call("POST", `/api/launches/${okId}/execute`);
    let done;
    for (let i = 0; i < 50; i++) {
      done = (await call("GET", `/api/launches/${okId}`)).json;
      if (done.status === "DONE" || done.status === "FAILED") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(done.status, JSON.stringify(done)).toBe("DONE");
    expect(done.bundleResult).toMatchObject({ transport: "simulated", bundleId: null, status: "confirmed" });
    expect(done.buys.map((b: { role: string; status: string }) => [b.role, b.status])).toEqual([
      ["bundle", "OK"],
      ["snipe", "OK"],
    ]);
    expect(await ctx.chain.get().reader.tokenBalance(done.mint, ws[0].address)).toBeGreaterThan(0n);
    expect(await ctx.chain.get().reader.tokenBalance(done.mint, ws[1].address)).toBeGreaterThan(0n);
    expect(await ctx.chain.get().reader.tokenBalance(done.mint, ws[2].address)).toBe(0n);
    const tips = await ctx.chain.get().reader.balances([...JITO_TIP_ACCOUNTS]);
    const tipped = [...tips.values()].reduce((a, b) => a + b, 0n);
    expect(tipped).toBe(TIP * 2n);
    expect(tips.get(tipAccountFor(`launch:${okId}:bundle`).toBase58())!).toBeGreaterThanOrEqual(TIP);
    await app.close();
  });
});

describe("Mock · el bundle es atómico y no se aplica dos veces", () => {
  it("un fallo a medias no deja la curva, y la misma clave no vuelve a comprar", async () => {
    const ledger = new (await import("../src/chain/mock")).MockLedger();
    const dev = Keypair.generate().publicKey.toBase58();
    const buyer = Keypair.generate().publicKey.toBase58();
    ledger.sol.set(dev, 2n * SOL);
    ledger.sol.set(buyer, 2n * SOL);
    const env = createMockEnv(() => new Uint8Array(64), ledger, () => 1, undefined, () => ({ enabled: true, tipLamports: TIP, endpoint: "https://mainnet.block-engine.jito.wtf", simulated: true }));
    const mint = Keypair.generate().publicKey.toBase58();
    const create = await env.adapter.buildCreateTx({ name: "A", symbol: "A", uri: "https://ipfs.io/ipfs/cid", creator: dev, mint, devBuyLamports: SOL / 10n, slippagePct: 15, mayhem: false });
    const [buy] = await env.adapter.buildLaunchBundleBuys({ mint, creator: dev, devBuyLamports: SOL / 10n, slippagePct: 15, mayhem: false, holderReward: false, buys: [{ user: buyer, lamports: SOL / 10n }] });
    ledger.failBundleAt = 1;
    const failed = await env.sender.sendBundle([{ tx: create, idempotencyKey: "c" }, { tx: buy, idempotencyKey: "b" }], { bundleKey: "once" });
    expect(failed.status).toBe("failed");
    expect(ledger.curves.has(mint)).toBe(false);
    ledger.failBundleAt = null;
    const ok = await env.sender.sendBundle([{ tx: create, idempotencyKey: "c" }, { tx: buy, idempotencyKey: "b" }], { bundleKey: "once" });
    expect(ok).toMatchObject({ status: "confirmed", simulated: true, bundleId: null, tipLamports: TIP });
    const bal = ledger.tokenOf(mint, buyer);
    const again = await env.sender.sendBundle([{ tx: create, idempotencyKey: "c" }, { tx: buy, idempotencyKey: "b" }], { bundleKey: "once" });
    expect(again).toMatchObject({ status: "confirmed", reused: true });
    expect(ledger.tokenOf(mint, buyer)).toBe(bal);
    expect([...JITO_TIP_ACCOUNTS].reduce((a, k) => a + ledger.balance(k), 0n)).toBe(TIP);
  });
});
