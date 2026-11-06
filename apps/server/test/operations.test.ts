// Movimientos de fondos (REQ-WAL-008, REQ-FUND-002/003, REQ-COST-001/002) contra mock y, con
// NEBULA_CHAIN_TESTS=1, contra Surfpool. Las mismas aserciones exactas en los dos backends.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app";
import { b58encode } from "../src/base58";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];
const SOL = 1_000_000_000n;

describe.each(backends)("Movimientos de fondos · %s", (backend) => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  let funder: { id: string; address: string };
  let ws: { id: string; address: string }[] = [];

  const call = async (method: "GET" | "POST" | "DELETE", url: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  const stepUp = async (action: string) => (await call("POST", "/api/vault/confirm", { password: PW, action })).json.token as string;
  const bal = async (a: string) => (ctx.chain.get().reader.balances([a]).then((m) => m.get(a)!)) as Promise<bigint>;
  const done = async (id: string) => {
    for (let i = 0; i < 600; i++) {
      const op = (await call("GET", `/api/operations/${id}`)).json;
      if (op.status !== "RUNNING") return op;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("La operación no terminó");
  };

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: backend === "mock" ? "mock" : "rpc" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    funder = (await call("POST", "/api/wallets", { count: 1, kind: "funder" })).json.wallets.find((w: { kind: string }) => w.kind === "funder");
    ws = (await call("POST", "/api/wallets", { count: 10, role: "holder" })).json.wallets.filter((w: { kind: string }) => w.kind === "wallet");
    expect((await call("POST", "/api/dev/airdrop", { walletIds: [funder.id], sol: 20 })).json.ok).toBe(1);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
  });

  it("E2E-04 · dispersar 0,1 SOL a 10 wallets: cada una recibe 0,1 exacto y el funder baja 1 SOL + las fees previstas", async () => {
    const before = await bal(funder.address);
    const pv = (await call("POST", "/api/operations/preview", { kind: "disperse", fromId: funder.id, toIds: ws.map((w) => w.id), lamportsEach: (SOL / 10n).toString() })).json;
    expect(pv).toMatchObject({ kind: "disperse", status: "PREVIEW", errors: [] });
    expect(pv.chunks.length).toBeGreaterThanOrEqual(1);
    expect(BigInt(pv.totalLamports)).toBe(SOL);
    const ex = await call("POST", `/api/operations/${pv.id}/execute`, {});
    expect(ex.status, JSON.stringify(ex.json)).toBe(200);
    const op = await done(pv.id);
    expect(op.status).toBe("COMPLETED");
    for (const w of ws) expect(await bal(w.address)).toBe(SOL / 10n);
    expect(before - (await bal(funder.address))).toBe(SOL + BigInt(pv.feeTotal)); // REQ-COST-001: coste mostrado = real
  });

  it("REQ-WAL-008 · dispersión con monto por wallet: cada una recibe exactamente lo suyo", async () => {
    const extra = (await call("POST", "/api/wallets", { count: 3 })).json.created as string[];
    const amounts = [{ walletId: extra[0], lamports: "1100000" }, { walletId: extra[1], lamports: "2200000" }, { walletId: extra[2], lamports: "3300000" }];
    const before = await bal(funder.address);
    const pv = (await call("POST", "/api/operations/preview", { kind: "disperse", fromId: funder.id, amounts })).json;
    expect(pv.errors).toEqual([]);
    expect(pv.items.map((i: { lamports: string }) => i.lamports)).toEqual(["1100000", "2200000", "3300000"]);
    await call("POST", `/api/operations/${pv.id}/execute`, {});
    expect((await done(pv.id)).status).toBe("COMPLETED");
    const addrs = (await call("GET", "/api/wallets")).json.wallets.filter((w: { id: string }) => extra.includes(w.id));
    const byId = Object.fromEntries(addrs.map((w: { id: string; address: string }) => [w.id, w.address]));
    for (const a of amounts) expect(await bal(byId[a.walletId])).toBe(BigInt(a.lamports));
    expect(before - (await bal(funder.address))).toBe(6_600_000n + BigInt(pv.feeTotal));
  });

  it("NFR-TX-001 · ejecutar dos veces la misma operación no duplica el efecto", async () => {
    const pv = (await call("POST", "/api/operations/preview", { kind: "transfer", fromId: funder.id, to: ws[0].address, lamports: "1000000" })).json;
    const before = await bal(ws[0].address);
    await call("POST", `/api/operations/${pv.id}/execute`, {});
    await done(pv.id);
    const again = await call("POST", `/api/operations/${pv.id}/execute`, {});
    expect(again.json.status).toBe("COMPLETED");
    expect((await bal(ws[0].address)) - before).toBe(1_000_000n);
  });

  it("Regla del rent: un destino vacío que recibiría menos del mínimo se rechaza con un motivo claro", async () => {
    const empty = (await call("POST", "/api/wallets", { count: 1 })).json.created[0];
    const pv = (await call("POST", "/api/operations/preview", { kind: "disperse", fromId: funder.id, toIds: [empty], lamportsEach: "500000" })).json;
    expect(pv.items[0]).toMatchObject({ status: "SKIPPED" });
    expect(pv.items[0].reason).toMatch(/mínimo exento de rent/);
    expect(pv.errors.join(" ")).toMatch(/ninguna transferencia válida/);
    expect((await call("POST", `/api/operations/${pv.id}/execute`, {})).status).toBe(400);
  });

  it("Recolectar con MAX deja cada origen exactamente en 0 (E2E-18: después se pueden borrar)", async () => {
    const pv = (await call("POST", "/api/operations/preview", { kind: "collect", fromIds: ws.map((w) => w.id), toId: funder.id })).json;
    expect(pv.errors).toEqual([]);
    expect(pv.sources.every((s: { after: string }) => s.after === "0")).toBe(true);
    await call("POST", `/api/operations/${pv.id}/execute`, {});
    expect((await done(pv.id)).status).toBe("COMPLETED");
    for (const w of ws) expect(await bal(w.address)).toBe(0n);
    const del = await call("DELETE", "/api/wallets", { ids: ws.slice(5).map((w) => w.id) }, { "x-nebula-stepup": await stepUp("delete-wallet") });
    expect(del.status).toBe(200);
  });

  it("E2E-19 · retiro a una dirección nueva: lo decide el servidor, avisa y exige reconfirmar", async () => {
    const ext = b58encode(randomBytes(32));
    const pv = (await call("POST", "/api/operations/preview", { kind: "transfer", fromId: funder.id, to: ext, lamports: (SOL / 100n).toString() })).json;
    expect(pv.kind).toBe("withdraw");
    expect(pv.external.newAddress).toBe(true);
    expect(pv.warnings.join(" ")).toMatch(/Dirección nueva/);
    expect((await call("POST", `/api/operations/${pv.id}/execute`, {})).status).toBe(403);
    expect((await call("POST", `/api/operations/${pv.id}/execute`, {}, { "x-nebula-stepup": await stepUp("withdraw") })).status).toBe(200);
    expect((await done(pv.id)).status).toBe("COMPLETED");
    expect(await bal(ext)).toBe(SOL / 100n);
    const again = (await call("POST", "/api/operations/preview", { kind: "transfer", fromId: funder.id, to: ext, lamports: "1000000" })).json;
    expect(again.external.newAddress).toBe(false); // ya está en la libreta
  });

  it("Dirección inválida o igual al origen se rechaza", async () => {
    expect((await call("POST", "/api/operations/preview", { kind: "transfer", fromId: funder.id, to: "no-es-una-direccion", lamports: "1" })).status).toBe(400);
    expect((await call("POST", "/api/operations/preview", { kind: "transfer", fromId: funder.id, to: funder.address, lamports: "1" })).status).toBe(400);
  });

  it.runIf(backend === "mock")("Un resultado pendiente (RPC caído) pausa la operación sin marcar nada como fallido; reanudar no duplica", async () => {
    const many = (await call("POST", "/api/wallets", { count: 45 })).json.created as string[];
    const pv = (await call("POST", "/api/operations/preview", { kind: "disperse", fromId: funder.id, toIds: many, lamportsEach: "1500000" })).json;
    expect(pv.chunks.length).toBeGreaterThanOrEqual(2);
    const ledger = ctx.chain.get().ledger!;
    ledger.failures.push("RPC_DOWN");
    await call("POST", `/api/operations/${pv.id}/execute`, {});
    const paused = await done(pv.id);
    expect(paused.status).toBe("PAUSED");
    expect(paused.items.some((i: { status: string }) => i.status === "FAILED")).toBe(false);
    await call("POST", `/api/operations/${pv.id}/resume`, {});
    expect((await done(pv.id)).status).toBe("COMPLETED");
    const addrs = (await call("GET", "/api/wallets")).json.wallets.filter((w: { id: string }) => many.includes(w.id)).map((w: { address: string }) => w.address);
    const bals = await ctx.chain.get().reader.balances(addrs);
    for (const a of addrs) expect(bals.get(a)).toBe(1_500_000n);
  });

  it.runIf(backend === "mock")("Bloquear a mitad de una dispersión la deja en PAUSED; reanudar no repite lo ya enviado", async () => {
    const many = (await call("POST", "/api/wallets", { count: 60 })).json.created as string[];
    const pv = (await call("POST", "/api/operations/preview", { kind: "disperse", fromId: funder.id, toIds: many, lamportsEach: "2000000" })).json;
    expect(pv.chunks.length).toBeGreaterThanOrEqual(2);
    const ledger = ctx.chain.get().ledger!;
    ledger.sendDelayMs = 60;
    await call("POST", `/api/operations/${pv.id}/execute`, {});
    const okCount = () => (ctx.db().prepare("SELECT COUNT(*) n FROM operation_item WHERE op_id = ? AND status = 'OK'").get(pv.id) as { n: number }).n;
    for (let i = 0; i < 100 && okCount() === 0; i++) await new Promise((r) => setTimeout(r, 10));
    ctx.vault.lock("manual"); // a mitad: el primer trozo ya entró, el resto no
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.ops.get(pv.id).status).toBe("PAUSED");
    const sentBefore = okCount();
    expect(sentBefore).toBeGreaterThan(0);
    expect(sentBefore).toBeLessThan(60);
    await call("POST", "/api/vault/unlock", { password: PW });
    expect((await call("GET", "/api/vault/status")).json.paused.some((p: { id: string }) => p.id === pv.id)).toBe(true);
    await call("POST", `/api/operations/${pv.id}/resume`, {});
    expect((await done(pv.id)).status).toBe("COMPLETED");
    ledger.sendDelayMs = 0;
    const addrs = (await call("GET", "/api/wallets")).json.wallets.filter((w: { id: string }) => many.includes(w.id)).map((w: { address: string }) => w.address);
    const bals = await ctx.chain.get().reader.balances(addrs);
    for (const a of addrs) expect(bals.get(a)).toBe(2_000_000n);
  });
});
