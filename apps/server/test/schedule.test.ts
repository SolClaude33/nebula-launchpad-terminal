// REQ-LAUNCH-015 / E2E-09 (API, mock, reloj inyectable): el lanzamiento programado persiste en SQLite,
// sobrevive a un reinicio, se lanza a su hora con la bóveda abierta, se pausa si llega bloqueada y se
// puede cancelar hasta T−10 s.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const MIN = 60_000;

async function open(dataDir: string, clock: { now: number }) {
  const built = await buildApp({ profile: "test", dataDir, token: "t".repeat(64), logToStdout: false, chainMode: "mock", clock: () => clock.now });
  const call = async (method: "GET" | "POST" | "PUT", url: string, body?: unknown) => {
    const r = await built.app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": built.ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  return { ...built, call };
}

async function prepare(a: Awaited<ReturnType<typeof open>>, symbol: string) {
  const dev = (await a.call("POST", "/api/wallets", { count: 1, role: "dev", labelPrefix: `Dev${symbol}` })).json.wallets.find((w: { label: string }) => w.label.startsWith(`Dev${symbol}`));
  await a.call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 2 });
  const imageCid = (await a.call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
  await a.call("POST", "/api/launches/alt", { payerWalletId: dev.id });
  const draftId = `d-${randomUUID()}`;
  const cfg = { draftId, name: `Programado ${symbol}`, symbol, description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: "100000000", mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true };
  await a.call("PUT", `/api/drafts/${draftId}`, { draftId, name: cfg.name, symbol });
  expect((await a.call("POST", "/api/launches/preflight", cfg)).json.preflight.ok).toBe(true);
  return { draftId, dev };
}

describe("REQ-LAUNCH-015 · lanzamiento programado", () => {
  it("E2E-09 · programado a T+2 min, se cierra y se abre la app, se desbloquea y se lanza a su hora; otro se cancela", async () => {
    const dir = tmpDir();
    const clock = { now: Date.parse("2026-11-06T12:00:00Z") };
    let a = await open(dir, clock);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const { draftId: id, dev } = await prepare(a, "TIME");
    const { draftId: other } = await prepare(a, "NOPE");
    const T = clock.now + 2 * MIN;
    // sin margen suficiente se rechaza
    expect((await a.call("POST", `/api/launches/${id}/schedule`, { at: clock.now + 5_000 })).status).toBe(400);
    const s = (await a.call("POST", `/api/launches/${id}/schedule`, { at: T })).json;
    expect(s.schedule).toMatchObject({ at: T, state: "WAITING", cancellableUntil: T - 10_000 });
    expect((await a.call("POST", `/api/launches/${other}/schedule`, { at: T + MIN })).status).toBe(200);
    // en /launches aparecen como programados y salen de Borradores
    const list = (await a.call("GET", "/api/launches?all=1")).json.items;
    expect(list.filter((l: { status: string }) => l.status === "SCHEDULED")).toHaveLength(2);
    expect((await a.call("GET", "/api/drafts")).json.items).toHaveLength(0);
    // cancelar el segundo: a T−5 s ya no se puede; con margen, sí
    clock.now = T + MIN - 5_000;
    expect((await a.call("POST", `/api/launches/${other}/schedule/cancel`)).status).toBe(409);
    clock.now = Date.parse("2026-11-06T12:00:30Z");
    expect((await a.call("POST", `/api/launches/${other}/schedule/cancel`)).json.schedule).toBeNull();
    await a.app.close();

    // reinicio: la bóveda arranca bloqueada y el programado sigue esperando (un reinicio no lo pausa)
    a = await open(dir, clock);
    expect((await a.call("GET", "/api/vault/status")).json.paused).toEqual([]);
    await a.call("POST", "/api/vault/unlock", { password: PW });
    // el libro mayor del mock vive en memoria: tras reiniciar, la wallet dev vuelve a tener saldo (en Surfpool persiste)
    await a.call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 2 });
    expect((await a.call("GET", `/api/launches/${id}`)).json.schedule.state).toBe("WAITING");
    clock.now = T - 1_000;
    expect(await a.ctx.launches.tickSchedule()).toBe(0);
    expect((await a.call("GET", `/api/launches/${id}`)).json.status).toBe("PREPARED");
    clock.now = T;
    expect(await a.ctx.launches.tickSchedule()).toBe(1);
    const done = await a.ctx.launches.waitIdle(id);
    expect(done).toMatchObject({ status: "DONE", schedule: null });
    expect(done.createSignature).toBeTruthy();
    // el cancelado vuelve a Borradores con su dry-run hecho
    expect((await a.call("GET", "/api/drafts")).json.items.map((d: { id: string }) => d.id)).toEqual([other]);
    const act = (await a.call("GET", "/api/activity?kind=launch")).json.items.map((x: { kind: string }) => x.kind);
    expect(act).toEqual(expect.arrayContaining(["launch.schedule", "launch.unschedule", "launch.schedule.fire", "launch.done"]));
    await a.app.close();
  });

  it("si llega la hora con la bóveda bloqueada no se lanza: queda PAUSED y al confirmar se lanza", async () => {
    const clock = { now: Date.parse("2026-11-06T12:00:00Z") };
    const a = await open(tmpDir(), clock);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const { draftId: id } = await prepare(a, "LOCK");
    const T = clock.now + MIN;
    await a.call("POST", `/api/launches/${id}/schedule`, { at: T });
    // bloquear pausa los programados (REQ-VAULT-003)
    await a.call("POST", "/api/vault/lock");
    clock.now = T + 1_000;
    await a.ctx.launches.tickSchedule();
    await a.call("POST", "/api/vault/unlock", { password: PW });
    const st = (await a.call("GET", "/api/vault/status")).json;
    expect(st.paused).toEqual([{ id, kind: "lanzamiento", label: "Lanzamiento programado de $LOCK" }]);
    expect((await a.call("GET", `/api/launches/${id}`)).json).toMatchObject({ status: "PREPARED", schedule: { state: "PAUSED" } });
    await a.ctx.launches.tickSchedule(); // aunque la bóveda esté abierta, nunca se reanuda solo
    expect((await a.call("GET", `/api/launches/${id}`)).json.status).toBe("PREPARED");
    // confirmar = lanzar ahora (ya pasó la hora)
    await a.call("POST", `/api/launches/${id}/resume`, {});
    expect((await a.ctx.launches.waitIdle(id)).status).toBe("DONE");
    expect((await a.call("GET", "/api/vault/status")).json.paused).toEqual([]);
    await a.app.close();
  });

  it("REVIEW-F1 P1-1 · si execute falla o la bóveda se bloquea al disparar, queda visible (FAILED o PAUSED); al arrancar no hay «disparados» huérfanos", async () => {
    const clock = { now: Date.parse("2026-11-06T12:00:00Z") };
    const dir = tmpDir();
    let a = await open(dir, clock);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const { draftId: boom } = await prepare(a, "BOOM");
    const { draftId: lock } = await prepare(a, "LCK");
    const { draftId: orphan } = await prepare(a, "ORPH");
    const T = clock.now + MIN;
    for (const id of [boom, lock, orphan]) await a.call("POST", `/api/launches/${id}/schedule`, { at: T });
    clock.now = T;
    // 1) execute lanza un error (p. ej. el RPC cae justo entonces): FAILED con el motivo y visible en /launches
    const realExecute = a.ctx.launches.execute.bind(a.ctx.launches);
    const realPreflight = a.ctx.launches.preflight.bind(a.ctx.launches);
    a.ctx.launches.execute = async (id: string) => (id === boom ? Promise.reject(new Error("RPC caído en el último momento")) : realExecute(id));
    // 2) la bóveda se bloquea mientras se rehace el dry-run del segundo
    a.ctx.launches.preflight = async (cfg: unknown) => {
      if ((cfg as { draftId: string }).draftId === lock) a.ctx.vault.lock("manual");
      return realPreflight(cfg);
    };
    // el tercero se queda como «disparado» huérfano, como si el proceso hubiera muerto (datos antiguos)
    a.ctx.db().prepare("UPDATE launch SET schedule_state = 'FIRED' WHERE id = ?").run(orphan);
    await a.ctx.launches.tickSchedule().catch(() => {});
    a.ctx.launches.execute = realExecute;
    a.ctx.launches.preflight = realPreflight;
    await a.call("POST", "/api/vault/unlock", { password: PW });
    const b = (await a.call("GET", `/api/launches/${boom}`)).json;
    expect(b).toMatchObject({ status: "PREPARED", createSignature: null, schedule: { state: "FAILED" } });
    expect(b.schedule.error).toMatch(/RPC caído/);
    expect((await a.call("GET", `/api/launches/${lock}`)).json.schedule.state).toBe("PAUSED");
    expect((await a.call("GET", "/api/vault/status")).json.paused.map((p: { id: string }) => p.id)).toContain(lock);
    await a.app.close();
    // al reabrir, el huérfano pasa a FAILED con el motivo
    a = await open(dir, clock);
    await a.call("POST", "/api/vault/unlock", { password: PW });
    const o = (await a.call("GET", `/api/launches/${orphan}`)).json;
    expect(o.schedule).toMatchObject({ state: "FAILED" });
    expect(o.schedule.error).toMatch(/interrumpió/);
    const listed = (await a.call("GET", "/api/launches?all=1")).json.items.map((l: { id: string; status: string }) => `${l.id}:${l.status}`);
    expect(listed).toEqual(expect.arrayContaining([`${boom}:FAILED`, `${orphan}:FAILED`, `${lock}:PAUSED`]));
    await a.app.close();
  });

  it("REVIEW-F1 P1-2 · con más de 2 min de retraso no se lanza solo aunque la bóveda esté abierta: PAUSED con el motivo", async () => {
    const clock = { now: Date.parse("2026-11-06T12:00:00Z") };
    const a = await open(tmpDir(), clock);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const { draftId: id } = await prepare(a, "LATE");
    const { draftId: ontime } = await prepare(a, "ONTIME");
    const T = clock.now + MIN;
    await a.call("POST", `/api/launches/${id}/schedule`, { at: T });
    await a.call("POST", `/api/launches/${ontime}/schedule`, { at: T + 10 * MIN - 30_000 });
    // el equipo estuvo suspendido 10 minutos con la bóveda abierta
    clock.now = T + 10 * MIN;
    await a.ctx.launches.tickSchedule();
    const v = (await a.call("GET", `/api/launches/${id}`)).json;
    expect(v).toMatchObject({ status: "PREPARED", createSignature: null, schedule: { state: "PAUSED" } });
    expect(v.schedule.error).toMatch(/10 min de retraso/);
    expect((await a.call("GET", "/api/vault/status")).json.paused).toEqual(expect.arrayContaining([{ id, kind: "lanzamiento", label: "Lanzamiento programado de $LATE (llegó tarde)" }]));
    // el que llega dentro de la ventana (30 s tarde) sí se lanza
    expect((await a.ctx.launches.waitIdle(ontime)).status).toBe("DONE");
    // confirmar = lanzar ahora
    await a.call("POST", `/api/launches/${id}/resume`, {});
    expect((await a.ctx.launches.waitIdle(id)).status).toBe("DONE");
    await a.app.close();
  });

  it("si a su hora el dry-run ya no pasa, queda FAILED con el motivo y no se envía nada", async () => {
    const clock = { now: Date.parse("2026-11-06T12:00:00Z") };
    const a = await open(tmpDir(), clock);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const { draftId: id, dev } = await prepare(a, "DRY");
    const T = clock.now + MIN;
    await a.call("POST", `/api/launches/${id}/schedule`, { at: T });
    // la wallet dev se queda sin saldo antes de la hora
    a.ctx.chain.get().ledger!.sol.set(dev.address, 1000n);
    clock.now = T;
    await a.ctx.launches.tickSchedule();
    const v = (await a.call("GET", `/api/launches/${id}`)).json;
    expect(v).toMatchObject({ status: "PREPARED", createSignature: null, schedule: { state: "FAILED" } });
    expect(v.schedule.error).toMatch(/dry-run/);
    expect((await a.call("GET", "/api/launches?all=1")).json.items[0]).toMatchObject({ status: "FAILED" });
    await a.app.close();
  });
});
