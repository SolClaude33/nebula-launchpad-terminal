// REQ-CORE-001: suite de contrato del adaptador. Corre contra el mock siempre y contra Surfpool
// (fork local de mainnet) con NEBULA_CHAIN_TESTS=1 (`pnpm test:chain`). Las dos deben comportarse igual.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { openDb } from "../src/db";
import { Vault, sodiumReady } from "../src/signer";
import { createChain, type Chain } from "../src/chain";
import { slipUp } from "../src/chain/pumpfun";
import { solToLamports, type PreparedTx } from "../src/chain/types";
import { PW, tmpDir } from "./helpers";

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];

describe.each(backends)("Contrato del adaptador · %s", (backend) => {
  let vault: Vault;
  let chain: Chain;
  let db: ReturnType<typeof openDb>;
  const addr: Record<string, string> = {};
  let mint = "";
  const key = () => randomUUID();

  async function wallet(label: string, sol: number) {
    const { address, sk } = await vault.generateKey();
    const id = randomUUID();
    db.prepare("INSERT INTO wallet(id, label, address, kind, encrypted_key, created_at) VALUES(?, ?, ?, 'wallet', ?, ?)").run(id, label, address, vault.sealKey(id, sk), Date.now());
    if (sol > 0) await chain.reader.airdrop!(address, solToLamports(sol));
    addr[label] = address;
    return address;
  }
  const bal = async (a: string) => (await chain.reader.balances([a])).get(a)!;
  const send = (tx: PreparedTx, k = key(), simulateOnly = false) => chain.sender.send(tx, { idempotencyKey: k, simulateOnly });

  beforeAll(async () => {
    await sodiumReady();
    db = openDb(tmpDir());
    vault = new Vault(() => db);
    await vault.setup(PW);
    chain = createChain({
      profile: "test",
      mode: backend === "mock" ? "mock" : "rpc",
      endpoints: [{ http: "http://127.0.0.1:8899", ws: "ws://127.0.0.1:8900" }],
      db: () => db,
      sign: (a, m) => vault.signMessage(a, m),
      priorityMicroLamports: () => 10_000,
    });
    await wallet("dev", 3);
    await wallet("holder", 2);
    await wallet("whale", 6);
    await wallet("pobre", 0.01);
  }, 120_000);
  afterAll(() => {
    chain?.stop();
    vault?.lock();
    db?.close();
  });

  it("capabilities: Pump.fun en Solana, dev buy en la misma transacción", () => {
    const c = chain.adapter.capabilities();
    expect(c).toMatchObject({ chain: "solana", bundleInSameTx: true, customMint: true, tokenDecimals: 6, graduatesTo: "PumpSwap" });
  });

  it("REQ-LAUNCH-017 · dry-run: simular no cambia saldos", async () => {
    mint = await vault.createMintKey();
    const tx = await chain.adapter.buildCreateTx({ name: "Kepler Test", symbol: "KTEST", uri: "https://example.invalid/m.json", creator: addr.dev, mint, devBuyLamports: solToLamports(0.5), slippagePct: 15, mayhem: false });
    const before = await bal(addr.dev);
    const r = await send(tx, key(), true);
    expect(r.status).toBe("simulated");
    expect(await bal(addr.dev)).toBe(before);
  });

  it("REQ-LAUNCH-008 · create + dev buy en una transacción; el dev recibe lo cotizado", async () => {
    const q = await chain.adapter.quoteCreate({ devBuyLamports: solToLamports(0.5), slippagePct: 15 });
    const tx = await chain.adapter.buildCreateTx({ name: "Kepler Test", symbol: "KTEST", uri: "https://example.invalid/m.json", creator: addr.dev, mint, devBuyLamports: solToLamports(0.5), slippagePct: 15, mayhem: false });
    expect(tx.signers).toEqual([addr.dev, mint]);
    const r = await send(tx);
    expect(r.status, show(r)).toBe("confirmed");
    expect(await chain.reader.tokenBalance(mint, addr.dev)).toBe(q.amountOut);
    expect(q.graduationPct).toBeGreaterThan(0);
  });

  it("compra: tokens = cotización y el gasto no supera el límite enviado", async () => {
    const before = await bal(addr.holder);
    const lamports = solToLamports(0.2);
    const q = await chain.adapter.quote({ mint, side: "buy", amount: lamports, slippagePct: 15 });
    expect(q.limit).toBe(slipUp(lamports, 15)); // REQ-LAUNCH-012: el slippage configurado es el que se envía
    const r = await send(await chain.adapter.buildBuyTx({ mint, user: addr.holder, lamports, slippagePct: 15 }));
    expect(r.status, show(r)).toBe("confirmed");
    expect(await chain.reader.tokenBalance(mint, addr.holder)).toBe(q.amountOut);
    const spent = before - (await bal(addr.holder));
    expect(spent).toBeLessThanOrEqual(q.limit + solToLamports(0.003)); // + fees de red, priority y rent de la cuenta
  });

  it("NFR-TX-001 · la misma idempotency key no duplica el efecto", async () => {
    const k = key();
    const tx = await chain.adapter.buildBuyTx({ mint, user: addr.holder, lamports: solToLamports(0.05), slippagePct: 15 });
    const t0 = await chain.reader.tokenBalance(mint, addr.holder);
    const a = await send(tx, k);
    const t1 = await chain.reader.tokenBalance(mint, addr.holder);
    const b = await send(tx, k);
    expect(a.status).toBe("confirmed");
    expect(b).toMatchObject({ status: "confirmed", reused: true });
    expect(await chain.reader.tokenBalance(mint, addr.holder)).toBe(t1);
    expect(t1).toBeGreaterThan(t0);
  });

  it("venta: recibe al menos el mínimo enviado", async () => {
    const tokens = (await chain.reader.tokenBalance(mint, addr.holder)) / 2n;
    const before = await bal(addr.holder);
    const q = await chain.adapter.quote({ mint, side: "sell", amount: tokens, slippagePct: 5 });
    const r = await send(await chain.adapter.buildSellTx({ mint, user: addr.holder, tokens, slippagePct: 5 }));
    expect(r.status, show(r)).toBe("confirmed");
    expect((await bal(addr.holder)) - before).toBeGreaterThanOrEqual(q.limit - solToLamports(0.001));
  });

  it("E2E-15 · slippage del 2 % respetado: si el precio se mueve un 5 %, falla con «slippage»", async () => {
    const tx = await chain.adapter.buildBuyTx({ mint, user: addr.holder, lamports: solToLamports(0.1), slippagePct: 2 });
    expect(tx.quote!.limit).toBe(slipUp(solToLamports(0.1), 2));
    // mover el precio antes de enviar
    if (chain.ledger) chain.ledger.priceShockPct = 5;
    else expect((await send(await chain.adapter.buildBuyTx({ mint, user: addr.whale, lamports: solToLamports(4), slippagePct: 50 }))).status).toBe("confirmed");
    const r = await send(tx);
    expect(r).toMatchObject({ status: "failed", code: "SLIPPAGE" });
  });

  it("saldo insuficiente se informa como tal y no se envía", async () => {
    const r = await send(await chain.adapter.buildBuyTx({ mint, user: addr.pobre, lamports: solToLamports(1), slippagePct: 15 }));
    expect(r).toMatchObject({ status: "failed", code: "INSUFFICIENT_FUNDS" });
  });

  it("REQ-REW-001 · las comisiones de creador se acumulan para el dev", async () => {
    const fees = await chain.adapter.claimableFees([addr.dev]);
    expect(fees.get(addr.dev)!).toBeGreaterThan(0n);
  });

  it.runIf(backend === "mock")("TEST-ENV-002 · fallos inyectables: RPC caído, bundle rechazado y blockhash caducado (se reintenta)", async () => {
    const l = chain.ledger!;
    const tx = await chain.adapter.buildBuyTx({ mint, user: addr.whale, lamports: solToLamports(0.01), slippagePct: 15 });
    l.failures.push("RPC_DOWN");
    expect(await send(tx)).toMatchObject({ status: "failed", code: "RPC_DOWN" });
    l.failures.push("BUNDLE_REJECTED");
    expect(await send(tx)).toMatchObject({ status: "failed", code: "BUNDLE_REJECTED" });
    l.failures.push("BLOCKHASH_EXPIRED");
    expect((await send(tx)).status).toBe("confirmed");
  });
});
