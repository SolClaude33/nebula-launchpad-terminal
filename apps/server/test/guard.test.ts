// REQ-LAUNCH-014 / E2E-10 contra mock y (NEBULA_CHAIN_TESTS=1) Surfpool: compras externas por encima del
// umbral durante las compras Quick → las compras planificadas que quedan se omiten y no se vende nada.
// El comprador externo es una keypair que NO está en la bóveda (en Surfpool firma y envía por su cuenta).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ComputeBudgetProgram, Connection, Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];
const SOL = 1_000_000_000n;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(backends)("Launch Guard · %s", (backend) => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  type W = { id: string; address: string; label: string };
  let dev: W;
  let holders: W[] = [];
  let imageCid = "";
  let n = 0;

  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };

  /** Compra de un tercero que la bóveda no controla. */
  const externalBuy = async (mint: string, buyer: Keypair, lamports: bigint) => {
    const chain = ctx.chain.get();
    if (backend === "mock") {
      const ledger = chain.ledger!;
      const user = buyer.publicKey.toBase58();
      ledger.sol.set(user, 50n * SOL);
      const q = await chain.adapter.quote({ mint, side: "buy", amount: lamports, slippagePct: 15 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = ledger.apply({ op: "buy", mint, user, tokens: q.amountOut, maxSol: q.limit } as any, 5000n);
      expect(r.ok).toBe(true);
      ledger.record(`mock-ext-${++n}`, user);
      return;
    }
    const conn = new Connection("http://127.0.0.1:8899", "confirmed");
    const sig = await conn.requestAirdrop(buyer.publicKey, Number(5n * SOL));
    await conn.confirmTransaction(sig, "confirmed");
    const tx = await chain.adapter.buildBuyTx({ mint, user: buyer.publicKey.toBase58(), lamports, slippagePct: 15 });
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: buyer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...(tx.payload as { instructions: import("@solana/web3.js").TransactionInstruction[] }).instructions] }).compileToV0Message();
    const v = new VersionedTransaction(msg);
    v.sign([buyer]);
    const s = await conn.sendRawTransaction(v.serialize());
    const c = await conn.confirmTransaction(s, "confirmed");
    expect(c.value.err).toBeNull();
  };

  const launch = async (guard: { thresholdLamports: string; windowSec: number; whitelist: string[] } | null) => {
    const draftId = `d-${randomUUID()}`;
    const cfg = { draftId, name: "Guardia", symbol: "GRD", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: (SOL / 10n).toString(), mode: "quick", holders: holders.map((h) => ({ walletId: h.id, lamports: (SOL / 10n).toString() })), slippagePct: 25, mayhem: false, feeMode: "creator", feeAck: true, guard };
    const pf = (await call("POST", "/api/launches/preflight", cfg)).json;
    expect(pf.preflight?.ok, JSON.stringify(pf)).toBe(true);
    await call("POST", `/api/launches/${draftId}/execute`, {});
    return draftId;
  };

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: backend === "mock" ? "mock" : "rpc" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    dev = (await call("POST", "/api/wallets", { count: 1, role: "dev", labelPrefix: "Dev" })).json.wallets.find((w: W) => w.label.startsWith("Dev"));
    holders = (await call("POST", "/api/wallets", { count: 3, role: "holder", labelPrefix: "Holder" })).json.wallets.filter((w: W) => w.label.startsWith("Holder"));
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 5 });
    await call("POST", "/api/dev/airdrop", { walletIds: holders.map((h) => h.id), sol: 2 });
    imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    expect((await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).status).toBe(200);
  }, 240_000);
  afterAll(async () => {
    ctx.launches.testHooks = {};
    await app?.close();
  });

  it("E2E-10 · compras externas por encima del umbral: se detienen las compras restantes y no se vende nada", async () => {
    const sniper = Keypair.generate();
    ctx.launches.testHooks.beforeBuy = async (id, ord) => {
      if (ord === 1) {
        const v = (await call("GET", `/api/launches/${id}`)).json;
        await externalBuy(v.mint, sniper, SOL); // 1 SOL de un tercero tras la primera compra propia
      }
    };
    const id = await launch({ thresholdLamports: (SOL / 2n).toString(), windowSec: 120, whitelist: [] });
    const v = await ctx.launches.waitIdle(id, 240_000);
    ctx.launches.testHooks = {};
    expect(v.status).toBe("DONE");
    expect((v.buys as { status: string }[]).map((b) => b.status)).toEqual(["OK", "SKIPPED", "SKIPPED"]);
    expect((v.buys as { reason: string }[])[1].reason).toMatch(/Launch Guard/);
    // nada vendido: ninguna venta propia en cadena y los holders omitidos no tienen tokens
    expect((ctx.db().prepare("SELECT COUNT(*) AS n FROM tx WHERE kind = 'sell'").get() as { n: number }).n).toBe(0);
    for (const h of holders.slice(1)) expect(await ctx.chain.get().reader.tokenBalance(v.mint, h.address)).toBe(0n);
    expect(await ctx.chain.get().reader.tokenBalance(v.mint, sniper.publicKey.toBase58())).toBeGreaterThan(0n);
    const act = (await call("GET", "/api/activity?kind=launch")).json.items as { kind: string; detail: string }[];
    expect(act.some((a) => a.kind === "launch.guard" && /no se vende nada/.test(a.detail))).toBe(true);
  }, 300_000);

  it.runIf(backend === "mock")("REVIEW-F1 P1-3 · si el guard no puede leer la cadena (429), falla cerrado: no se compra a ciegas", async () => {
    let calls = 0;
    ctx.launches.testHooks.beforeBuy = async (_id, ord) => {
      if (ord === 1)
        ctx.launches.attachTrades(async () => {
          calls++;
          throw new Error("429 Too Many Requests");
        });
    };
    const id = await launch({ thresholdLamports: (SOL / 2n).toString(), windowSec: 120, whitelist: [] });
    const v = await ctx.launches.waitIdle(id);
    ctx.launches.testHooks = {};
    ctx.launches.attachTrades((mint) => ctx.live.tradesNow(mint));
    expect(v.status).toBe("DONE");
    expect((v.buys as { status: string }[]).map((b) => b.status)).toEqual(["OK", "SKIPPED", "SKIPPED"]);
    expect((v.buys as { reason: string }[])[1].reason).toMatch(/sin datos de la cadena/);
    expect(calls).toBe(2); // un reintento antes de omitir
    expect((ctx.db().prepare("SELECT COUNT(*) AS n FROM tx WHERE kind = 'sell'").get() as { n: number }).n).toBe(0);
  });

  it.runIf(backend === "mock")("una dirección de la lista blanca no cuenta como externa: el plan se completa", async () => {
    const friend = Keypair.generate();
    ctx.launches.testHooks.beforeBuy = async (id, ord) => {
      if (ord === 1) await externalBuy((await call("GET", `/api/launches/${id}`)).json.mint, friend, SOL);
    };
    const id = await launch({ thresholdLamports: (SOL / 2n).toString(), windowSec: 120, whitelist: [friend.publicKey.toBase58()] });
    const v = await ctx.launches.waitIdle(id);
    ctx.launches.testHooks = {};
    expect((v.buys as { status: string }[]).map((b) => b.status)).toEqual(["OK", "OK", "OK"]);
  });

  it.runIf(backend === "mock")("pasada la ventana (mínimo 1 s) el guard termina y las compras siguen", async () => {
    const late = Keypair.generate();
    ctx.launches.testHooks.beforeBuy = async (id, ord) => {
      if (ord === 1) {
        await externalBuy((await call("GET", `/api/launches/${id}`)).json.mint, late, SOL);
        await sleep(1_200);
      }
    };
    const id = await launch({ thresholdLamports: (SOL / 2n).toString(), windowSec: 1, whitelist: [] });
    const v = await ctx.launches.waitIdle(id);
    ctx.launches.testHooks = {};
    expect((v.buys as { status: string }[]).map((b) => b.status)).toEqual(["OK", "OK", "OK"]);
    // la ventana mínima es 1 s
    const bad = await call("POST", "/api/launches/preflight", { draftId: `d-${randomUUID()}`, name: "X", symbol: "X", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: "1", mode: "quick", holders: [{ walletId: holders[0].id, lamports: "1000" }], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true, guard: { thresholdLamports: "1", windowSec: 0, whitelist: [] } });
    expect(bad.status).toBe(400);
  });
});
