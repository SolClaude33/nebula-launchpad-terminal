// Bloque 6 · automatizaciones (REQ-AUTO-001…010, E2E-02, E2E-13, E2E-14) contra el mock y
// (NEBULA_CHAIN_TESTS=1) Surfpool. El reloj del motor es controlable: los intervalos se «adelantan».
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AutomationConfig, automationIssues, dcaPlan, DcaConfig, ladderTargets, LimitConfig, trailingStopUsd } from "@nebula/shared";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];
const SOL = 1_000_000_000n;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
vi.setConfig({ testTimeout: 240_000 });

describe("plan y validación (sin cadena)", () => {
  const dca = (over: Record<string, unknown>) => DcaConfig.parse({ type: "dca", side: "buy", mint: "M".repeat(32), walletIds: ["a"], amount: { kind: "fixed", each: "100" }, intervalSec: 60, end: { kind: "amount", totalAmount: "300" }, ...over });
  it("REQ-AUTO-001 · rango = rampa determinista del mínimo al máximo (sin aleatoriedad)", () => {
    const p = dcaPlan(dca({ amount: { kind: "range", min: "100", max: "300" }, end: { kind: "duration", durationSec: 300 } }), 1);
    expect(p.executions).toBe(5);
    expect([0, 1, 2, 3, 4, 5].map((k) => p.amountAt(k).toString())).toEqual(["100", "150", "200", "250", "300", "300"]);
    // dos llamadas dan lo mismo
    expect(p.amountAt(2)).toBe(dcaPlan(dca({ amount: { kind: "range", min: "100", max: "300" }, end: { kind: "duration", durationSec: 300 } }), 1).amountAt(2));
    // fin por monto: N·(min+max)/2 ≥ total por wallet
    expect(dcaPlan(dca({ amount: { kind: "range", min: "100", max: "300" }, end: { kind: "amount", totalAmount: "2000" } }), 2).executions).toBe(5);
    // lo primero que llegue
    expect(dcaPlan(dca({ end: { kind: "first", totalAmount: "1000", durationSec: 180 } }), 1).executions).toBe(3);
  });
  it("REQ-AUTO-001 · el intervalo máximo es 24 h y el fin necesita sus datos", () => {
    expect(() => dca({ intervalSec: 86_401 })).toThrow();
    expect(automationIssues(dca({ end: { kind: "first", totalAmount: "100" } }))).toContain("Indica la duración.");
    expect(automationIssues(dca({ amount: { kind: "range", min: "300", max: "100" } }))[0]).toMatch(/mínimo del rango/);
    // slippage 5 % por defecto también en ventas
    expect(dca({ side: "sell" }).slippagePct).toBe(5);
  });
  it("REQ-AUTO-002 · compras con objetivos descendentes y ventas ascendentes", () => {
    const lim = (side: "buy" | "sell", mcs: number[]) => automationIssues(LimitConfig.parse({ type: "limit", side, mint: "M".repeat(32), walletIds: ["a"], targets: mcs.map((mcUsd) => ({ mcUsd, ...(side === "buy" ? { lamportsEach: "1000" } : { pct: 50 }) })) }));
    expect(lim("buy", [50_000, 40_000, 30_000])).toEqual([]);
    expect(lim("buy", [30_000, 40_000])[0]).toMatch(/mayor a menor/);
    expect(lim("sell", [30_000, 40_000])).toEqual([]);
    expect(lim("sell", [40_000, 40_000])[0]).toMatch(/menor a mayor/);
  });

  it("REQ-AUTO-003 · ladder: N tramos geométricos ascendentes entre dos market caps, válidos como límite de venta", () => {
    const t = ladderTargets(100_000, 1_600_000, 5, 20);
    expect(t.map((x) => x.mcUsd)).toEqual([100_000, 200_000, 400_000, 800_000, 1_600_000]);
    expect(t.every((x) => x.pct === 20)).toBe(true);
    expect(automationIssues(LimitConfig.parse({ type: "limit", side: "sell", mint: "M".repeat(32), walletIds: ["a"], targets: t }))).toEqual([]);
    expect(ladderTargets(500, 100, 3, 10)).toEqual([]); // hasta < desde: nada
    expect(ladderTargets(100, 200, 40, 10)).toHaveLength(10); // como mucho 10 tramos
  });

  it("REQ-AUTO-004 · trailing stop: solo venta, caída entre 1 y 90 %, precio de disparo desde el máximo", () => {
    const base = { type: "trailing", side: "sell", mint: "M".repeat(32), walletIds: ["a"], sellPct: 50 };
    expect(AutomationConfig.safeParse({ ...base, trailPct: 20 }).success).toBe(true);
    expect(AutomationConfig.safeParse({ ...base, trailPct: 0.5 }).success).toBe(false);
    expect(AutomationConfig.safeParse({ ...base, trailPct: 95 }).success).toBe(false);
    expect(AutomationConfig.safeParse({ ...base, side: "buy", trailPct: 20 }).success).toBe(false);
    expect(trailingStopUsd(100_000, 20)).toBe(80_000);
  });
});

describe.each(backends)("Automatizaciones · %s", (backend) => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  const dataDir = tmpDir();
  type W = { id: string; address: string; label: string };
  let dev: W, whale: W, poor: W;
  let holders: W[] = [];
  let mint = "";
  let now = Date.now();
  const clock = () => now;
  const open = async () => ({ app, ctx } = await buildApp({ profile: "test", dataDir, token: "t".repeat(64), logToStdout: false, chainMode: backend === "mock" ? "mock" : "rpc", clock }));

  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  const make = async (prefix: string, count = 1, role?: string) => (await call("POST", "/api/wallets", { count, labelPrefix: prefix, ...(role ? { role } : {}) })).json.wallets.filter((w: W) => w.label.startsWith(prefix)) as W[];
  const order = async (body: Record<string, unknown>) => {
    const id = randomUUID();
    expect((await call("POST", "/api/trade", { id, mint, slippagePct: 15, mode: "parallel", ...body })).status).toBe(200);
    let v = await ctx.trading.waitIdle(id);
    // el fork perezoso de Surfpool a veces tarda en traer cuentas de mainnet y el envío queda pendiente:
    // como en la app, se reanuda la misma orden (mismas keys, sin duplicar)
    for (let i = 0; i < 8 && v.status === "PAUSED"; i++) {
      await sleep(5000);
      await call("POST", `/api/trade/${id}/resume`);
      v = await ctx.trading.waitIdle(id);
    }
    return v;
  };
  const tokens = (a: string) => ctx.chain.get().reader.tokenBalance(mint, a);
  const mcUsd = async () => {
    const s = (await call("GET", `/api/live/${mint}`)).json;
    return (Number(s.info.marketCapLamports) / 1e9) * s.solUsd.usd;
  };
  /** crea (y opcionalmente inicia) una tarea; devuelve su vista */
  const task = async (config: Record<string, unknown>, start = true) => {
    const r = await call("POST", "/api/automations", { id: randomUUID(), config: { mint, slippagePct: 15, ...config }, start });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json;
  };
  const view = async (id: string) => (await call("GET", `/api/automations/${id}`)).json;
  /** espera a que el motor llegue a una condición (el temporizador corre cada 300 ms) */
  const until = async (id: string, ok: (v: any) => boolean, ms = 120_000) => {
    const t0 = Date.now();
    for (;;) {
      await ctx.automations.waitIdle(id);
      const v = await view(id);
      if (ok(v)) return v;
      if (Date.now() - t0 > ms) throw new Error(`No se cumplió la condición: ${JSON.stringify(v.status)} ${JSON.stringify(v.state)} ${JSON.stringify(v.progress)}`);
      await sleep(100);
    }
  };
  /** deja pasar varios ticks del motor sin adelantar el reloj */
  const settle = async (id: string) => {
    await sleep(900);
    return ctx.automations.waitIdle(id);
  };
  const runs = async (id: string) => (await call("GET", `/api/automations/${id}/executions?limit=100`)).json.items as { seq: number; generation: number; orderId: string; items: { walletId: string; status: string; amount: string; signature: string | null; side: string; retries: number }[] }[];

  beforeAll(async () => {
    await open();
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    [dev] = await make("Dev", 1, "dev");
    holders = await make("Holder", 3, "holder");
    [whale] = await make("Ballena");
    [poor] = await make("Pobre");
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 3 });
    await call("POST", "/api/dev/airdrop", { walletIds: holders.map((h) => h.id), sol: 2 });
    await call("POST", "/api/dev/airdrop", { walletIds: [whale.id], sol: 30 });
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    const alt = await call("POST", "/api/launches/alt", { payerWalletId: dev.id });
    expect(alt.status, JSON.stringify(alt.json)).toBe(200);
    const draftId = `d-${randomUUID()}`;
    const cfg = { draftId, name: "Órbita Auto", symbol: "ORBA", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: (SOL / 2n).toString(), mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true };
    expect((await call("POST", "/api/launches/preflight", cfg)).json.preflight.ok).toBe(true);
    await call("POST", `/api/launches/${draftId}/execute`);
    const v = await ctx.launches.waitIdle(draftId);
    expect(v.status).toBe("DONE");
    mint = v.mint;
    // los holders compran para tener posición que vender
    const b = await order({ side: "buy", walletIds: holders.map((h) => h.id), lamportsEach: (SOL / 5n).toString() });
    expect(b.status, JSON.stringify(b.items)).toBe("COMPLETED");
  }, 240_000);
  afterAll(async () => {
    await app?.close();
  });

  it("REQ-AUTO-005/010 · la API valida orden de objetivos, intervalo y la wallet dev («incl. dev» solo si se activa)", async () => {
    const bad = await call("POST", "/api/automations", { id: randomUUID(), config: { type: "limit", side: "sell", mint, walletIds: [holders[0].id], targets: [{ mcUsd: 9e6, pct: 10 }, { mcUsd: 8e6, pct: 10 }] } });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/menor a mayor/);
    const long = await call("POST", "/api/automations", { id: randomUUID(), config: { type: "dca", side: "buy", mint, walletIds: [holders[0].id], amount: { kind: "fixed", each: "1000" }, intervalSec: 90_000, end: { kind: "duration", durationSec: 3600 } } });
    expect(long.status).toBe(400);
    const dcaBody = { type: "dca", side: "buy", mint, walletIds: [dev.id, holders[0].id], amount: { kind: "fixed", each: "1000000" }, intervalSec: 60, end: { kind: "duration", durationSec: 600 } };
    const noDev = await call("POST", "/api/automations", { id: randomUUID(), config: dcaBody });
    expect(noDev.status).toBe(400);
    expect(noDev.json.message).toMatch(/wallet dev .* excluida/);
    const withDev = await task({ ...dcaBody, includeDev: true }, false);
    expect(withDev.status).toBe("IDLE");
    expect(withDev.includesDev).toBe(true);
    expect(withDev.config.slippagePct).toBe(15);
    const plain = await task({ ...dcaBody, walletIds: [holders[0].id] }, false);
    expect(plain.includesDev).toBe(false);
    // por defecto, 5 % de slippage también en ventas
    const sell = (await call("POST", "/api/automations", { id: randomUUID(), config: { type: "limit", side: "sell", mint, walletIds: [holders[0].id], targets: [{ mcUsd: 9e9, pct: 10 }] } })).json;
    expect(sell.config.slippagePct).toBe(5);
    for (const t of [withDev, plain, sell]) expect((await call("DELETE", `/api/automations/${t.id}`)).status).toBe(200);
  });

  it("REQ-AUTO-001 · DCA de compra fijo con fin por monto: una ejecución por intervalo, key propia por ejecución y sin backlog", async () => {
    const each = SOL / 100n;
    const ws = holders.slice(0, 2);
    const t = await task({ type: "dca", side: "buy", walletIds: ws.map((w) => w.id), amount: { kind: "fixed", each: each.toString() }, intervalSec: 60, end: { kind: "amount", totalAmount: (each * 6n).toString() } });
    expect(t.status).toBe("RUNNING");
    let v = await until(t.id, (x) => x.progress.executions === 1);
    // no vuelve a ejecutar hasta que pase el intervalo
    await settle(t.id);
    expect((await view(t.id)).progress.executions).toBe(1);
    // aunque pasen 10 intervalos, solo hay UNA ejecución y se reprograma desde ella
    now += 600_000;
    v = await until(t.id, (x) => x.progress.executions === 2);
    await settle(t.id);
    expect((await view(t.id)).progress.executions).toBe(2);
    now += 60_000;
    v = await until(t.id, (x) => x.status !== "RUNNING");
    expect(v.status, JSON.stringify(v.state)).toBe("COMPLETED");
    expect(v.state.endReason).toMatch(/Monto total/);
    expect(v.progress.spent).toBe((each * 6n).toString());
    const r = await runs(t.id);
    expect(r.map((x) => x.seq)).toEqual([2, 1, 0]);
    const keys = new Set<string>();
    for (const run of r) {
      expect(run.items.map((i) => i.status)).toEqual(["OK", "OK"]);
      for (const i of run.items) {
        expect(i.amount).toBe(each.toString());
        expect(i.signature).toBeTruthy();
        keys.add(`trade:${run.orderId}:${i.walletId}`);
      }
    }
    expect(keys.size).toBe(6);
    // el sender recibió exactamente esas keys (el real las registra en la tabla tx antes de emitir)
    if (backend === "surfpool") {
      const tx = ctx.db().prepare(`SELECT idempotency_key, status FROM tx WHERE idempotency_key LIKE ?`).all(`trade:auto-${t.id}-%`) as { idempotency_key: string; status: string }[];
      expect(new Set(tx.map((x) => x.idempotency_key))).toEqual(keys);
      expect(tx.every((x) => x.status === "CONFIRMED")).toBe(true);
    } else {
      expect(new Set([...ctx.chain.get().ledger!.sent.keys()].filter((k) => k.startsWith(`trade:auto-${t.id}-`)))).toEqual(keys);
    }
  });

  it("REQ-AUTO-001 · DCA en rango con fin por duración: rampa mín→máx y COMPLETED al cumplirse", async () => {
    const t = await task({ type: "dca", side: "buy", walletIds: [holders[2].id], amount: { kind: "range", min: (SOL / 200n).toString(), max: (SOL / 100n).toString() }, intervalSec: 60, end: { kind: "duration", durationSec: 180 } });
    await until(t.id, (x) => x.progress.executions === 1);
    now += 60_000;
    await until(t.id, (x) => x.progress.executions === 2);
    now += 60_000;
    await until(t.id, (x) => x.progress.executions === 3);
    now += 60_000;
    const v = await until(t.id, (x) => x.status !== "RUNNING");
    expect(v.status, JSON.stringify(v.state)).toBe("COMPLETED");
    expect(v.state.endReason).toMatch(/Duración/);
    const amounts = (await runs(t.id)).reverse().map((r) => r.items[0].amount);
    expect(amounts).toEqual(["5000000", "7500000", "10000000"]);
  });

  it("E2E-13 · DCA de venta cada 1 min y límite: pausar, editar, reanudar y parar sin que se venda nada; registro correcto", async () => {
    const seller = holders[0];
    const unit = 10n ** 6n;
    const dca = await task({ type: "dca", side: "sell", walletIds: [seller.id], amount: { kind: "fixed", each: (1000n * unit).toString() }, intervalSec: 60, end: { kind: "duration", durationSec: 3600 }, slippagePct: 5 });
    const far = (await mcUsd()) * 50;
    const lim = await task({ type: "limit", side: "sell", walletIds: [seller.id], targets: [{ mcUsd: far, pct: 50 }], slippagePct: 5 });
    // la primera venta del DCA entra
    let d = await until(dca.id, (x) => x.progress.executions === 1);
    let l = await until(lim.id, (x) => !!x.state.waiting?.startsWith("Esperando"));
    expect(l.progress.fired).toBe(0);
    const t1 = await tokens(seller.address);

    // pausar: aunque pasen intervalos, no se vende nada
    expect((await call("POST", `/api/automations/${dca.id}/pause`)).json.status).toBe("PAUSED");
    expect((await call("POST", `/api/automations/${lim.id}/pause`)).json.status).toBe("PAUSED");
    now += 5 * 60_000;
    await settle(dca.id);
    expect(await tokens(seller.address)).toBe(t1);
    // editar en caliente (solo en pausa): otro monto y otro objetivo
    const running = await call("PATCH", `/api/automations/${dca.id}`, { config: { ...dca.config, amount: { kind: "fixed", each: (500n * unit).toString() } } });
    expect(running.status).toBe(200);
    expect(running.json.config.amount.each).toBe((500n * unit).toString());
    expect((await call("PATCH", `/api/automations/${lim.id}`, { config: { ...lim.config, targets: [{ mcUsd: far * 2, pct: 25 }] } })).json.config.targets[0].pct).toBe(25);
    // reanudar: una sola ejecución (sin backlog) con el monto nuevo; el límite sigue esperando
    expect((await call("POST", `/api/automations/${dca.id}/resume`)).json.status).toBe("RUNNING");
    expect((await call("POST", `/api/automations/${lim.id}/resume`)).json.status).toBe("RUNNING");
    d = await until(dca.id, (x) => x.progress.executions === 2);
    await settle(dca.id);
    expect((await view(dca.id)).progress.executions).toBe(2);
    const t2 = await tokens(seller.address);
    expect(t1 - t2).toBe(500n * unit);
    // en marcha no se edita
    expect((await call("PATCH", `/api/automations/${dca.id}`, { config: dca.config })).status).toBe(409);
    // parar: no se vende nada más, ni al pasar el tiempo
    expect((await call("POST", `/api/automations/${dca.id}/stop`)).json.status).toBe("STOPPED");
    expect((await call("POST", `/api/automations/${lim.id}/stop`)).json.status).toBe("STOPPED");
    now += 10 * 60_000;
    await settle(dca.id);
    expect(await tokens(seller.address)).toBe(t2);
    l = await view(lim.id);
    expect(l.progress.fired).toBe(0);
    // registro: 2 ejecuciones de venta con hora, wallet, lado, monto, firma y estado
    const r = await runs(dca.id);
    expect(r).toHaveLength(2);
    expect(r[0].items[0]).toMatchObject({ walletId: seller.id, side: "sell", status: "OK", amount: (500n * unit).toString() });
    expect(r[1].items[0]).toMatchObject({ walletId: seller.id, side: "sell", status: "OK", amount: (1000n * unit).toString() });
    expect(r.every((x) => x.items[0].signature)).toBe(true);
    expect(await runs(lim.id)).toHaveLength(0);
    // «Cargar anteriores»: paginación por cursor
    const p1 = (await call("GET", `/api/automations/${dca.id}/executions?limit=1`)).json;
    expect(p1.items).toHaveLength(1);
    expect(p1.before).toBeTruthy();
    const p2 = (await call("GET", `/api/automations/${dca.id}/executions?limit=1&before=${p1.before}`)).json;
    expect(p2.items[0].seq).toBe(0);
    expect(p2.before).toBeNull();
  });

  it("REQ-AUTO-002 · límites por market cap en USD: venta ascendente al subir el precio y compra descendente", async () => {
    const mc = await mcUsd();
    const seller = holders[1];
    const before = await tokens(seller.address);
    const sell = await task({ type: "limit", side: "sell", walletIds: [seller.id], targets: [{ mcUsd: mc * 1.05, pct: 10 }, { mcUsd: mc * 1.3, pct: 10 }] });
    await until(sell.id, (x) => !!x.state.waiting?.startsWith("Esperando"));
    expect(await tokens(seller.address)).toBe(before);
    // la ballena sube el market cap por encima de los dos objetivos
    const w = await order({ side: "buy", walletIds: [whale.id], lamportsEach: (10n * SOL).toString() });
    expect(w.status).toBe("COMPLETED");
    expect(await mcUsd()).toBeGreaterThan(mc * 1.3);
    const v = await until(sell.id, (x) => x.status !== "RUNNING");
    expect(v.status, JSON.stringify(v.state)).toBe("COMPLETED");
    expect(v.progress.fired).toBe(2);
    const r = (await runs(sell.id)).reverse();
    expect(r.map((x) => x.items[0].status)).toEqual(["OK", "OK"]);
    expect(BigInt(r[0].items[0].amount)).toBe(before / 10n);
    expect(await tokens(seller.address)).toBe(before - BigInt(r[0].items[0].amount) - BigInt(r[1].items[0].amount));
    // compra con objetivos descendentes: los dos están por encima del market cap actual y se ejecutan en orden
    const mc2 = await mcUsd();
    const buy = await task({ type: "limit", side: "buy", walletIds: [holders[2].id], targets: [{ mcUsd: mc2 * 3, lamportsEach: (SOL / 100n).toString() }, { mcUsd: mc2 * 2, lamportsEach: (SOL / 50n).toString() }] });
    const b = await until(buy.id, (x) => x.status !== "RUNNING");
    expect(b.status).toBe("COMPLETED");
    expect((await runs(buy.id)).reverse().map((x) => x.items[0].amount)).toEqual([(SOL / 100n).toString(), (SOL / 50n).toString()]);
  });

  it("REQ-AUTO-005 · fuera del rango de market cap espera sin ejecutar; «parar tras N errores» acaba en FAILED", async () => {
    const mc = await mcUsd();
    const out = await task({ type: "dca", side: "buy", walletIds: [holders[2].id], amount: { kind: "fixed", each: "1000000" }, intervalSec: 60, end: { kind: "duration", durationSec: 600 }, mcMaxUsd: mc / 2 });
    const v = await until(out.id, (x) => !!x.state.waiting?.includes("fuera del rango"));
    expect(v.progress.executions).toBe(0);
    await call("POST", `/api/automations/${out.id}/stop`);
    // una wallet sin SOL: cada ejecución queda omitida y a la 2.ª seguida la tarea falla con el motivo
    const err = await task({ type: "dca", side: "buy", walletIds: [poor.id], amount: { kind: "fixed", each: "1000000" }, intervalSec: 60, end: { kind: "duration", durationSec: 600 }, maxErrors: 2 });
    await until(err.id, (x) => x.progress.executions === 1);
    now += 60_000;
    const f = await until(err.id, (x) => x.status !== "RUNNING");
    expect(f.status).toBe("FAILED");
    expect(f.state.endReason).toMatch(/2 ejecuciones seguidas.*Saldo insuficiente/);
  });

  it("REQ-AUTO-004 · trailing stop: espera la activación, sigue el máximo sin vender y vende una vez al caer", async () => {
    const seller = holders[0];
    const before = await tokens(seller.address);
    expect(before).toBeGreaterThan(0n);
    const mc = await mcUsd();
    const tr = await task({ type: "trailing", side: "sell", walletIds: [seller.id], trailPct: 20, sellPct: 50, activationMcUsd: mc * 1.1 });
    await until(tr.id, (x) => !!x.state.waiting?.startsWith("Esperando activación"));
    // la ballena sube el market cap: se activa y sigue el máximo, sin vender
    const up = await order({ side: "buy", walletIds: [whale.id], lamportsEach: (5n * SOL).toString() });
    expect(up.status).toBe("COMPLETED");
    const high = await mcUsd();
    expect(high).toBeGreaterThan(mc * 1.1);
    const armed = await until(tr.id, (x) => x.progress.armed === true && x.progress.peakUsd >= high * 0.999);
    expect(armed.state.waiting).toMatch(/Máximo .* salta a/);
    expect(armed.progress.stopUsd).toBeCloseTo(armed.progress.peakUsd * 0.8, 0);
    expect(await tokens(seller.address)).toBe(before);
    // la ballena vende todo: el market cap cae más del 20 % desde el máximo y salta (una sola venta del 50 %)
    const down = await order({ side: "sell", walletIds: [whale.id], pct: 100 });
    expect(down.status).toBe("COMPLETED");
    expect(await mcUsd()).toBeLessThan(armed.progress.peakUsd * 0.8);
    const done = await until(tr.id, (x) => x.status !== "RUNNING");
    expect(done.status, JSON.stringify(done.state)).toBe("COMPLETED");
    expect(done.state.endReason).toMatch(/Trailing stop ejecutado/);
    const r = await runs(tr.id);
    expect(r).toHaveLength(1);
    expect(r[0].items[0].status).toBe("OK");
    expect(BigInt(r[0].items[0].amount)).toBe(before / 2n);
    expect(await tokens(seller.address)).toBe(before - BigInt(r[0].items[0].amount));
  });

  it("REQ-AUTO-006 · duplicar, borrar solo si está parada y ejecutar de nuevo con keys nuevas", async () => {
    const t = await task({ type: "dca", side: "buy", walletIds: [holders[2].id], amount: { kind: "fixed", each: "2000000" }, intervalSec: 60, end: { kind: "amount", totalAmount: "2000000" } });
    let v = await until(t.id, (x) => x.status !== "RUNNING");
    expect(v.status, JSON.stringify(v.state)).toBe("COMPLETED");
    const copy = (await call("POST", `/api/automations/${t.id}/duplicate`)).json;
    expect(copy).toMatchObject({ status: "IDLE", label: expect.stringMatching(/copia/) });
    expect(copy.id).not.toBe(t.id);
    expect((await call("POST", `/api/automations/${copy.id}/start`)).json.status).toBe("RUNNING");
    // en marcha (o en pausa) no se borra
    expect((await call("DELETE", `/api/automations/${copy.id}`)).status).toBe(409);
    await until(copy.id, (x) => x.status !== "RUNNING");
    v = (await call("POST", `/api/automations/${t.id}/rerun`)).json;
    expect(v).toMatchObject({ status: "RUNNING", generation: 2 });
    v = await until(t.id, (x) => x.status !== "RUNNING");
    expect(v.status, JSON.stringify(v.state)).toBe("COMPLETED");
    const r = await runs(t.id);
    expect(r.map((x) => x.orderId)).toEqual([`auto-${t.id}-2-0`, `auto-${t.id}-1-0`]);
    expect((await call("DELETE", `/api/automations/${copy.id}`)).status).toBe(200);
    expect((await call("GET", `/api/automations/${copy.id}`)).status).toBe(404);
  });

  it.runIf(backend === "mock")("un envío pendiente pausa la tarea (nunca FAILED); al reanudar no se duplica nada", async () => {
    ctx.chain.get().ledger!.failures.push("RPC_DOWN");
    const t = await task({ type: "dca", side: "buy", walletIds: [holders[2].id], amount: { kind: "fixed", each: "3000000" }, intervalSec: 60, end: { kind: "amount", totalAmount: "3000000" } });
    let v = await until(t.id, (x) => x.status !== "RUNNING");
    expect(v.status).toBe("PAUSED");
    expect(v.state.lastError).toMatch(/RPC caído/);
    expect((await call("GET", "/api/vault/status")).json.paused).toContainEqual(expect.objectContaining({ id: t.id, kind: "automatización" }));
    // la orden hija no se reanuda por su cuenta
    expect((await call("POST", `/api/trade/${v.state.inFlight}/resume`)).status).toBe(409);
    await call("POST", `/api/automations/${t.id}/resume`);
    v = await until(t.id, (x) => x.status !== "RUNNING");
    expect(v.status, JSON.stringify(v.state)).toBe("COMPLETED");
    const r = await runs(t.id);
    expect(r).toHaveLength(1);
    expect(r[0].items[0]).toMatchObject({ status: "OK", retries: 1 });
    expect((await call("GET", "/api/vault/status")).json.paused.some((p: { id: string }) => p.id === t.id)).toBe(false);
  });

  it.runIf(backend === "mock")("un error del RPC antes de enviar se reintenta (cuenta como error); con N=1 falla y cierra la orden a medias", async () => {
    const reader = ctx.chain.get().reader;
    const orig = reader.balances.bind(reader);
    const target = holders[2].address;
    let fails = 1;
    reader.balances = async (addrs: string[]) => {
      if (addrs.length === 1 && addrs[0] === target && fails-- > 0) throw new Error("RPC inyectado: sin respuesta");
      return orig(addrs);
    };
    try {
      const t = await task({ type: "dca", side: "buy", walletIds: [holders[2].id], amount: { kind: "fixed", each: "1000000" }, intervalSec: 60, end: { kind: "amount", totalAmount: "1000000" } });
      let v = await until(t.id, (x) => !!x.state.waiting?.startsWith("Reintentando"));
      expect(v).toMatchObject({ status: "RUNNING", state: { consecErrors: 1 } });
      now += 6_000;
      v = await until(t.id, (x) => x.status !== "RUNNING");
      expect(v.status).toBe("COMPLETED");
      expect((await runs(t.id))[0].items[0]).toMatchObject({ status: "OK", retries: 1 });

      fails = 1;
      const f = await task({ type: "dca", side: "buy", walletIds: [holders[2].id], amount: { kind: "fixed", each: "1000000" }, intervalSec: 60, end: { kind: "amount", totalAmount: "1000000" }, maxErrors: 1 });
      v = await until(f.id, (x) => x.status !== "RUNNING" && x.state.inFlight === null);
      expect(v.status).toBe("FAILED");
      expect(v.state.endReason).toMatch(/RPC inyectado/);
      const item = (await runs(f.id))[0].items[0];
      expect(item.status).toBe("SKIPPED");
      expect((await call("GET", `/api/trade/auto-${f.id}-1-0`)).json.status).not.toBe("PAUSED");
    } finally {
      reader.balances = orig;
    }
  });

  it.runIf(backend === "mock")("REQ-AUTO-010 · con una ejecución a medias no se cambian las wallets al editar", async () => {
    ctx.chain.get().ledger!.failures.push("RPC_DOWN");
    const t = await task({ type: "dca", side: "buy", walletIds: [holders[2].id], amount: { kind: "fixed", each: "1000000" }, intervalSec: 60, end: { kind: "duration", durationSec: 600 } });
    const v = await until(t.id, (x) => x.status === "PAUSED");
    expect(v.state.inFlight).toBeTruthy();
    const r = await call("PATCH", `/api/automations/${t.id}`, { config: { ...t.config, walletIds: [holders[1].id] } });
    expect(r.status).toBe(409);
    expect(r.json.message).toMatch(/ejecución a medias/);
    // otros cambios sí (afectan a las siguientes ejecuciones)
    expect((await call("PATCH", `/api/automations/${t.id}`, { config: { ...t.config, intervalSec: 120 } })).status).toBe(200);
    await call("POST", `/api/automations/${t.id}/stop`);
  });

  it("E2E-02 · al bloquear, el DCA en marcha queda PAUSED y solo se reanuda tras confirmarlo", async () => {
    const t = await task({ type: "dca", side: "buy", walletIds: [holders[2].id], amount: { kind: "fixed", each: "1000000" }, intervalSec: 60, end: { kind: "duration", durationSec: 3600 } });
    await until(t.id, (x) => x.progress.executions === 1);
    await call("POST", "/api/vault/lock");
    expect((await call("GET", `/api/automations/${t.id}`)).status).toBe(423);
    expect(ctx.db().prepare("SELECT status FROM task WHERE id = ?").get(t.id)).toEqual({ status: "PAUSED" });
    await call("POST", "/api/vault/unlock", { password: PW });
    const st = (await call("GET", "/api/vault/status")).json;
    expect(st.paused).toContainEqual(expect.objectContaining({ id: t.id, kind: "automatización" }));
    now += 5 * 60_000;
    await settle(t.id);
    expect((await view(t.id))).toMatchObject({ status: "PAUSED", progress: { executions: 1 } });
    await call("POST", `/api/automations/${t.id}/resume`);
    await until(t.id, (x) => x.progress.executions === 2);
    await call("POST", `/api/automations/${t.id}/stop`);
  });

  it("E2E-14 · con un DCA en marcha se cierra el proceso: al volver está PAUSED y no se reanuda solo", async () => {
    const t = await task({ type: "dca", side: "buy", walletIds: [holders[2].id], amount: { kind: "fixed", each: "1000000" }, intervalSec: 60, end: { kind: "duration", durationSec: 3600 } });
    await until(t.id, (x) => x.progress.executions === 1);
    await app.close();
    await open();
    await call("POST", "/api/vault/unlock", { password: PW });
    expect((await call("GET", "/api/vault/status")).json.paused).toContainEqual(expect.objectContaining({ id: t.id, kind: "automatización" }));
    now += 10 * 60_000;
    await settle(t.id);
    expect(await view(t.id)).toMatchObject({ status: "PAUSED", progress: { executions: 1 } });
    expect((await call("POST", `/api/automations/${t.id}/resume`)).json.status).toBe("RUNNING");
    // el mock vive en memoria y no sobrevive al reinicio; contra Surfpool la ejecución tras reanudar es real
    if (backend === "surfpool") {
      await until(t.id, (x) => x.progress.executions === 2);
      expect((await runs(t.id)).flatMap((r) => r.items.map((i) => i.status))).toEqual(["OK", "OK"]);
    }
    expect((await call("POST", `/api/automations/${t.id}/stop`)).json.status).toBe("STOPPED");
  });
});
