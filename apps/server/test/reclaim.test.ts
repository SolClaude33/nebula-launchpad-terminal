// REQ-WAL-010 · recuperar rent contra mock y (NEBULA_CHAIN_TESTS=1) Surfpool: una wallet que acaba de vender
// el 100 % se queda con su cuenta de token vacía; cerrarla manda el rent al destino (que paga la fee).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { buildApp } from "../src/app";
import { CLOSE_CHUNK } from "../src/reclaim";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];
const SOL = 1_000_000_000n;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(backends)("Recuperar rent · %s", (backend) => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  type W = { id: string; address: string; label: string };
  let dev: W, seller: W, busy: W, funder: W;
  let mint = "";

  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  const sol = async (a: string) => (await ctx.chain.get().reader.balances([a])).get(a)!;
  const trade = async (body: Record<string, unknown>) => {
    const id = randomUUID();
    expect((await call("POST", "/api/trade", { id, mint, slippagePct: 15, mode: "parallel", ...body })).status).toBe(200);
    for (let i = 0; i < 600; i++) {
      const v = (await call("GET", `/api/trade/${id}`)).json;
      if (v.status !== "RUNNING") return v;
      await sleep(100);
    }
    throw new Error("La orden no terminó");
  };

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: backend === "mock" ? "mock" : "rpc" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const mk = async (body: Record<string, unknown>, prefix: string) => ((await call("POST", "/api/wallets", { count: 1, labelPrefix: prefix, ...body })).json.wallets as (W & { kind: string })[]).find((w) => w.label.startsWith(prefix))!;
    dev = await mk({ role: "dev" }, "Dev");
    seller = await mk({}, "Vende");
    busy = await mk({}, "Ocupada");
    funder = await mk({ kind: "funder" }, "Funder");
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 2 });
    await call("POST", "/api/dev/airdrop", { walletIds: [seller.id, busy.id], sol: 0.5 });
    await call("POST", "/api/dev/airdrop", { walletIds: [funder.id], sol: 1 });
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    expect((await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).status).toBe(200);
    const draftId = `d-${randomUUID()}`;
    const cfg = { draftId, name: "Rent Test", symbol: "RENT", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: (SOL / 10n).toString(), mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true };
    expect((await call("POST", "/api/launches/preflight", cfg)).json.preflight.ok).toBe(true);
    await call("POST", `/api/launches/${draftId}/execute`, {});
    mint = (await ctx.launches.waitIdle(draftId)).mint;
    // compran y venden el 100 %: se quedan con la cuenta de token vacía
    expect((await trade({ side: "buy", walletIds: [seller.id, busy.id], lamportsEach: (SOL / 20n).toString() })).status).toBe("COMPLETED");
    expect((await trade({ side: "sell", walletIds: [seller.id, busy.id], pct: 100 })).status).toBe("COMPLETED");
    // la sesión dejó vacía la wallet del colector de la venta: el SOL de las ventas ya está en ellas
    await call("POST", "/api/operations/preview", { kind: "collect", fromIds: [seller.id], toId: funder.id }).then(async (r) => {
      await call("POST", `/api/operations/${r.json.id}/execute`, {});
      for (let i = 0; i < 600; i++) {
        const v = (await call("GET", `/api/operations/${r.json.id}`)).json;
        if (v.status !== "RUNNING") break;
        await sleep(100);
      }
    });
  }, 300_000);
  afterAll(async () => {
    await app?.close();
  });

  it("escanear: la cuenta vacía de quien vendió todo aparece con su rent", async () => {
    const scan = (await call("GET", "/api/reclaim")).json;
    const s = scan.items.find((i: { walletId: string }) => i.walletId === seller.id);
    expect(s).toMatchObject({ accounts: 1, busy: null });
    expect(BigInt(s.lamports)).toBeGreaterThan(2_000_000n);
    // la dev conserva tokens: su cuenta no está vacía y no se toca
    expect(scan.items.find((i: { walletId: string }) => i.walletId === dev.id)).toBeUndefined();
  });

  it("una wallet ocupada (orden en pausa) se omite con el motivo", async () => {
    const now = Date.now();
    ctx.db().prepare("INSERT INTO trade_order(id, mint, side, status, config, created_at, updated_at) VALUES('o-pausa', ?, 'buy', 'PAUSED', '{}', ?, ?)").run(mint, now, now);
    ctx.db().prepare("INSERT INTO trade_order_item(order_id, ord, wallet_id, status) VALUES('o-pausa', 0, ?, 'PENDING')").run(busy.id);
    const pv = (await call("POST", "/api/reclaim/preview", { walletIds: [busy.id], toId: funder.id })).json;
    expect(pv.items[0]).toMatchObject({ status: "SKIPPED", reason: expect.stringContaining("orden") });
    ctx.db().prepare("DELETE FROM trade_order WHERE id = 'o-pausa'").run();
  });

  it("cerrar: el destino (que paga la fee) recibe el rent − fee al lamport y la cuenta deja de existir", async () => {
    const chain = ctx.chain.get();
    const [acct] = await chain.reader.emptyTokenAccounts(seller.address);
    expect(await sol(seller.address)).toBe(0n); // la dueña no tiene SOL: firma, pero paga el destino
    // Surfpool (fork perezoso): la primera simulación con una firmante sin cuenta (0 SOL) va a buscarla a mainnet y
    // tarda ~16 s (RPC_UNREACHABLE); las siguientes, < 1 s. Medido el 2026-11-07. En mainnet no pasa.
    if (backend === "surfpool") await call("POST", "/api/reclaim/preview", { walletIds: [seller.id], toId: funder.id });
    const pv = (await call("POST", "/api/reclaim/preview", { walletIds: [seller.id], toId: funder.id })).json;
    expect(pv.status, JSON.stringify(pv)).toBe("PREVIEW");
    const it0 = pv.items[0];
    expect(it0.status, it0.reason).toBe("PENDING");
    expect(BigInt(it0.rent)).toBe(acct.lamports);
    expect(BigInt(it0.expected) + BigInt(it0.fee)).toBe(acct.lamports);
    const before = await sol(funder.address);
    expect((await call("POST", `/api/reclaim/${pv.id}/execute`)).status).toBe(200);
    const v = await ctx.reclaim.waitIdle(pv.id);
    expect(v.status, JSON.stringify(v.items)).toBe("COMPLETED");
    expect(v.items[0].received).toBe(it0.expected);
    expect((await sol(funder.address)) - before).toBe(BigInt(it0.expected));
    expect(await chain.reader.accountExists(acct.address)).toBe(false);
    expect((await chain.reader.emptyTokenAccounts(seller.address)).length).toBe(0);
    // repetir la ejecución no envía nada más
    expect((await call("POST", `/api/reclaim/${pv.id}/execute`)).json.status).toBe("COMPLETED");
  });

  it.runIf(backend === "surfpool")(`${CLOSE_CHUNK} cierres con dos firmas caben en una transacción`, async () => {
    const chain = ctx.chain.get();
    const accounts = Array.from({ length: CLOSE_CHUNK }, (_, i) => ({ address: Keypair.generate().publicKey.toBase58(), mint: Keypair.generate().publicKey.toBase58(), program: i % 2 ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 2_039_280n }));
    const tx = await chain.adapter.buildCloseAccountsTx({ owner: seller.address, dest: funder.address, accounts });
    const msg = new TransactionMessage({
      payerKey: new PublicKey(tx.payer),
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: tx.cuLimit! }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }), ...(tx.payload as { instructions: TransactionInstruction[] }).instructions],
    }).compileToV0Message();
    const bytes = new VersionedTransaction(msg).serialize().length;
    expect(bytes).toBeLessThanOrEqual(1232);
  });
});
