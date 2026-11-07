// E2E-23 (REQ-DASH-001/002) contra mock y (NEBULA_CHAIN_TESTS=1) Surfpool: después de un lanzamiento Quick
// y de operar hasta cerrar la posición, el P&L cuadra con las transacciones, fees incluidas.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const backends: ("mock" | "surfpool")[] = ["mock", ...(process.env.NEBULA_CHAIN_TESTS === "1" ? (["surfpool"] as const) : [])];
const SOL = 1_000_000_000n;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(backends)("Dashboard y P&L · %s", (backend) => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let ctx: Awaited<ReturnType<typeof buildApp>>["ctx"];
  type W = { id: string; address: string; label: string };
  let dev: W;
  let holders: W[] = [];
  let mint = "";
  let initial = 0n;

  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
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
  const all = () => [dev, ...holders].map((w) => w.address);
  const total = async () => [...(await ctx.chain.get().reader.balances(all())).values()].reduce((a, b) => a + b, 0n);

  beforeAll(async () => {
    ({ app, ctx } = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: backend === "mock" ? "mock" : "rpc" }));
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    // REQ-DASH-005: sin lanzamientos ni trades, el dashboard está vacío y lo dice
    const empty = (await call("GET", "/api/dashboard?period=all")).json;
    expect(empty).toMatchObject({ counts: { wallets: 0, launches: 0 }, totals: { trades: 0, pnlLamports: 0 } });
    dev = (await call("POST", "/api/wallets", { count: 1, role: "dev", labelPrefix: "Dev" })).json.wallets.find((w: W) => w.label.startsWith("Dev"));
    holders = (await call("POST", "/api/wallets", { count: 2, role: "holder", labelPrefix: "Holder" })).json.wallets.filter((w: W) => w.label.startsWith("Holder"));
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 3 });
    await call("POST", "/api/dev/airdrop", { walletIds: holders.map((h) => h.id), sol: 1 });
    initial = await total();
    const imageCid = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    expect((await call("POST", "/api/launches/alt", { payerWalletId: dev.id })).status).toBe(200);
    const draftId = `d-${randomUUID()}`;
    const cfg = { draftId, name: "Cuadre", symbol: "PNL", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: ((SOL * 3n) / 10n).toString(), mode: "quick", holders: holders.map((h) => ({ walletId: h.id, lamports: (SOL / 5n).toString() })), slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true };
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

  it("E2E-23 · tras comprar y vender todo, el P&L = ventas − compras − fees reales y Δ SOL de las wallets lo confirma", async () => {
    // segunda compra de un holder que ya tiene cuenta de token: no crea cuentas (rent 0)
    const second = await order({ side: "buy", walletIds: [holders[0].id], lamportsEach: (SOL / 20n).toString() });
    expect(second.status).toBe("COMPLETED");
    // cerrar la posición: vender el 100 % desde todas las wallets propias
    const sell = await order({ side: "sell", walletIds: [dev.id, ...holders.map((h) => h.id)], pct: 100, slippagePct: 5 });
    expect(sell.status, JSON.stringify(sell.items)).toBe("COMPLETED");

    let d = (await call("GET", "/api/dashboard?period=all")).json;
    for (let i = 0; i < 40 && d.indexing.pending > 0; i++) await sleep(500), (d = (await call("GET", "/api/dashboard?period=all")).json);
    expect(d.indexing.pending).toBe(0);
    const db = ctx.db();
    const txs = db.prepare("SELECT idempotency_key AS k, kind, mint, signature, fee_lamports, chain_fee, own_delta FROM tx WHERE status = 'CONFIRMED'").all() as { k: string; kind: string; mint: string | null; signature: string; fee_lamports: number | null; chain_fee: number; own_delta: number }[];

    // 1) Completitud: la suma de Δ SOL propios leídos de cada transacción = variación real de los saldos
    const deltaSum = txs.reduce((a, t) => a + BigInt(t.own_delta), 0n);
    expect(deltaSum).toBe((await total()) - initial);

    // 2) La fee real de cada envío es la que mostró la vista previa (REQ-COST-001)
    for (const t of txs) if (t.fee_lamports !== null) expect(t.chain_fee, t.k).toBe(t.fee_lamports);

    // 3) La segunda compra no crea cuentas: Δ SOL = −(SOL del trade con fees del pad + fee de red)
    const sig2 = second.items[0].signature as string;
    const t2 = txs.find((t) => t.signature === sig2)!;
    const trade2 = db.prepare("SELECT lamports, fee FROM live_trade WHERE signature = ?").get(sig2) as { lamports: string; fee: string };
    expect(BigInt(t2.own_delta)).toBe(-(BigInt(trade2.lamports) + BigInt(t2.chain_fee)));
    expect(BigInt(trade2.fee)).toBeGreaterThan(0n);

    // 4) Posición cerrada: P&L = realizado − fees de red (sin comisiones reclamadas) y realizado = ventas − compras
    const own = new Set(all());
    const trades = db.prepare("SELECT side, lamports, user FROM live_trade WHERE mint = ?").all(mint) as { side: string; lamports: string; user: string }[];
    const mine = trades.filter((t) => own.has(t.user));
    expect(mine.length).toBe(1 + 2 + 1 + 3); // dev buy, 2 holders, 2.ª compra y 3 ventas
    const buys = mine.filter((t) => t.side === "buy").reduce((a, t) => a + Number(t.lamports), 0);
    const sells = mine.filter((t) => t.side === "sell").reduce((a, t) => a + Number(t.lamports), 0);
    const fees = txs.reduce((a, t) => a + t.chain_fee, 0);
    expect(d.totals).toMatchObject({ trades: 7, buysLamports: buys, sellsLamports: sells, networkFeesLamports: fees, claimsLamports: 0, unrealizedLamports: 0 });
    expect(Math.abs(d.totals.realizedLamports - (sells - buys))).toBeLessThanOrEqual(2);
    expect(Math.abs(d.totals.pnlLamports - (sells - buys - fees))).toBeLessThanOrEqual(2);
    // el rent (cuentas del mint, de la curva, de token y la tabla de direcciones aparte) se informa por separado
    expect(d.totals.rentLamports).toBeGreaterThan(0);
    expect(d.totals.rentLamports).toBeLessThan(Number(SOL / 10n));
    // y Δ SOL de las transacciones del token = P&L + fees de fuera del token − rent
    const mintDelta = txs.filter((t) => t.mint === mint).reduce((a, t) => a + t.own_delta, 0);
    const otherFees = txs.filter((t) => t.mint !== mint).reduce((a, t) => a + t.chain_fee, 0);
    expect(Math.abs(d.totals.pnlLamports + otherFees - d.totals.rentLamports - mintDelta)).toBeLessThanOrEqual(2);

    // 5) Serie acumulada, lanzamiento y win rate
    expect(Math.abs(d.series[d.series.length - 1].cumLamports - d.totals.pnlLamports)).toBeLessThanOrEqual(d.series.length * 2);
    const l = d.launches.find((x: { mint: string }) => x.mint === mint);
    expect(l).toMatchObject({ symbol: "PNL", unrealizedLamports: 0 });
    expect(l.investedLamports).toBe(buys);
    expect(d.winRate.total).toBe(1);
    expect(d.avgPerLaunchLamports).toBe(l.pnlLamports);
    expect(BigInt(d.balances.walletsLamports)).toBe(await total());
  }, 300_000);

  it("REQ-WAL-009 · actividad por wallet: cuadra con el Δ SOL real de cada holder y suma lo del dashboard", async () => {
    const d = (await call("GET", "/api/dashboard?period=all")).json;
    const acts = await Promise.all([dev, ...holders].map(async (w) => (await call("GET", `/api/wallets/${w.id}/activity`)).json));
    // la suma por wallet de trades, compras y ventas es lo del dashboard (misma fuente)
    expect(acts.reduce((a, x) => a + x.trades, 0)).toBe(d.totals.trades);
    expect(acts.reduce((a, x) => a + x.buysLamports, 0)).toBe(d.totals.buysLamports);
    expect(acts.reduce((a, x) => a + x.sellsLamports, 0)).toBe(d.totals.sellsLamports);
    for (const [i, h] of holders.entries()) {
      const a = acts[i + 1];
      // vendió todo: realizado = ventas − compras, sin posición abierta
      expect(a.open).toEqual([]);
      expect(Math.abs(a.realizedLamports - (a.sellsLamports - a.buysLamports))).toBeLessThanOrEqual(2);
      // el holder solo operó: Δ SOL en cadena desde su airdrop de 1 SOL = realizado − fees − Jito − rent
      const now = (await ctx.chain.get().reader.balances([h.address])).get(h.address)!;
      const delta = Number(now - SOL);
      const est = a.realizedLamports - a.networkFeesLamports - a.jitoLamports - a.rentLamports;
      expect(Math.abs(est - delta), `${h.label}: ${est} vs ${delta}`).toBeLessThanOrEqual(Math.max(2, Math.abs(delta) / 100));
      expect(a.trades).toBe(i === 0 ? 3 : 2);
      expect(a.inNebulaSince).toBeGreaterThan(0);
      expect(a.firstActivityAt).toBeGreaterThan(0);
    }
    expect((await call("GET", "/api/wallets/no-existe/activity")).status).toBe(404);
  });

  it("REQ-DASH-001 · los períodos filtran por fecha: en 24 H por horas y sin trades fuera de rango", async () => {
    const d = (await call("GET", "/api/dashboard?period=24h")).json;
    expect(d.bucket).toBe("hour");
    expect(d.series.length).toBeGreaterThanOrEqual(24);
    expect(d.totals.trades).toBe(7);
    expect((await call("GET", "/api/dashboard?period=semana")).status).toBe(400);
  });

  it("REQ-DASH-003 · calendario: el mes y el año suman lo mismo que el P&L de «Todo», en hora local", async () => {
    const tz = 180; // UTC−3
    const all = (await call("GET", `/api/dashboard?period=all&tz=${tz}`)).json;
    const now = new Date(Date.now() - tz * 60_000);
    const [y, m, day] = [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
    const mon = (await call("GET", `/api/dashboard/calendar?year=${y}&month=${m}&tz=${tz}`)).json;
    expect(mon.cells).toHaveLength(new Date(Date.UTC(y, m, 0)).getUTCDate());
    expect(mon.firstWeekday).toBe((new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7);
    // todo pasó hoy: una sola celda con movimientos y el total cuadra con el resumen
    expect(mon.cells.filter((c: { moves: number }) => c.moves > 0).map((c: { index: number }) => c.index)).toEqual([day]);
    expect(Math.abs(mon.totalLamports - all.totals.pnlLamports)).toBeLessThanOrEqual(1);
    const yr = (await call("GET", `/api/dashboard/calendar?year=${y}&tz=${tz}`)).json;
    expect(yr.cells).toHaveLength(12);
    expect(yr.cells[m - 1].pnlLamports).toBe(mon.totalLamports);
    expect((await call("GET", `/api/dashboard/calendar?year=${y}&month=13`)).status).toBe(400);
  });
});
