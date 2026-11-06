import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { makeApp, PW, tmpDir } from "./helpers";
import { open, seal } from "../src/signer";

type Closable = { app: { close: () => Promise<unknown> } };
const apps: Closable[] = [];
const track = <T extends Closable>(a: T) => (apps.push(a), a);
afterEach(async () => {
  vi.useRealTimers();
  while (apps.length) await apps.pop()!.app.close();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("REQ-VAULT-001 · primer arranque", () => {
  it("exige ≥ 12 caracteres y la casilla «Entiendo»; sin bóveda no hay wallets", async () => {
    const { call } = track(await makeApp());
    expect((await call("GET", "/api/vault/status")).json).toMatchObject({ initialized: false, unlocked: false, profile: "test" });
    expect((await call("POST", "/api/wallets", { count: 1 })).status).toBe(423);
    expect((await call("POST", "/api/vault/setup", { password: "corta", ack: true })).status).toBe(400);
    expect((await call("POST", "/api/vault/setup", { password: PW })).status).toBe(400);
    const ok = await call("POST", "/api/vault/setup", { password: PW, ack: true });
    expect(ok.json).toMatchObject({ initialized: true, unlocked: true });
    expect((await call("POST", "/api/vault/setup", { password: PW, ack: true })).status).toBe(409);
  });

  it("E2E-01 · la base en disco no contiene la contraseña ni claves legibles", async () => {
    const { call, ctx, dataDir, stepUp } = track(await makeApp());
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const w = await call("POST", "/api/wallets", { count: 3 });
    expect(w.json.wallets).toHaveLength(3);
    const keys = (await call("POST", "/api/wallets/export", { ids: w.json.created }, { "x-nebula-stepup": await stepUp("export-keys") })).json.keys;
    ctx.db().pragma("wal_checkpoint(TRUNCATE)");
    const disk = readFileSync(join(dataDir, "nebula.sqlite")).toString("latin1");
    expect(disk).not.toContain(PW);
    for (const k of keys) expect(disk).not.toContain(k.secretKey);
    expect(disk).toContain(keys[0].address); // las direcciones son públicas
  });
});

describe("REQ-VAULT-002 · desbloqueo con retardo creciente", () => {
  it("contraseña errónea no abre nada, el retardo crece y persiste tras reiniciar", async () => {
    const dir = tmpDir();
    const a = await makeApp(dir);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    await a.call("POST", "/api/vault/lock");
    expect((await a.call("GET", "/api/wallets")).status).toBe(423);
    const bad = await a.call("POST", "/api/vault/unlock", { password: "no-es-esta-clave" });
    expect(bad.status).toBe(400);
    expect(bad.json.retryInSec).toBe(2);
    expect((await a.call("POST", "/api/vault/unlock", { password: PW })).status).toBe(429);
    await a.app.close();
    const b = track(await makeApp(dir));
    expect((await b.call("GET", "/api/vault/status")).json.retryInSec).toBeGreaterThan(0);
    await sleep(2100);
    expect((await b.call("POST", "/api/vault/unlock", { password: PW })).json.unlocked).toBe(true);
  });
});

describe("Cifrado · AES-256-GCM con AAD", () => {
  it("un byte alterado o un cifrado movido a otra fila no descifra", () => {
    const key = randomBytes(32);
    const blob = seal(key, "wallet:a", Buffer.from("secreto"));
    expect(open(key, "wallet:a", blob).toString()).toBe("secreto");
    const tampered = Buffer.from(blob);
    tampered[14] ^= 1;
    expect(() => open(key, "wallet:a", tampered)).toThrow();
    expect(() => open(key, "wallet:b", blob)).toThrow();
  });
});

describe("REQ-VAULT-004 · reconfirmación en el servidor", () => {
  it("exportar sin reconfirmar se rechaza; el token es de un solo uso y va ligado a la acción", async () => {
    const { call, stepUp } = track(await makeApp());
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const ids = (await call("POST", "/api/wallets", { count: 1 })).json.created;
    expect((await call("POST", "/api/wallets/export", { ids })).status).toBe(403);
    expect((await call("POST", "/api/vault/confirm", { password: "mala-contraseña", action: "export-keys" })).status).toBe(400);
    const wrongAction = await stepUp("delete-wallet");
    expect((await call("POST", "/api/wallets/export", { ids }, { "x-nebula-stepup": wrongAction })).status).toBe(403);
    const t = await stepUp("export-keys");
    expect((await call("POST", "/api/wallets/export", { ids }, { "x-nebula-stepup": t })).status).toBe(200);
    expect((await call("POST", "/api/wallets/export", { ids }, { "x-nebula-stepup": t })).status).toBe(403);
  });
});

describe("REQ-VAULT-006 · cambio de contraseña", () => {
  it("la antigua deja de servir y la nueva abre las mismas claves", async () => {
    const { call, stepUp } = track(await makeApp());
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const ids = (await call("POST", "/api/wallets", { count: 2 })).json.created;
    const before = (await call("POST", "/api/wallets/export", { ids }, { "x-nebula-stepup": await stepUp("export-keys") })).json.keys;
    const NEW = "otra contraseña bastante larga";
    expect((await call("POST", "/api/vault/change-password", { newPassword: NEW })).status).toBe(403);
    expect((await call("POST", "/api/vault/change-password", { newPassword: NEW }, { "x-nebula-stepup": await stepUp("change-password") })).status).toBe(200);
    await call("POST", "/api/vault/lock");
    expect((await call("POST", "/api/vault/unlock", { password: PW })).status).toBe(400);
    await sleep(2100);
    expect((await call("POST", "/api/vault/unlock", { password: NEW })).status).toBe(200);
    const after = (await call("POST", "/api/wallets/export", { ids }, { "x-nebula-stepup": await stepUp("export-keys", NEW) })).json.keys;
    expect(after.map((k: { secretKey: string }) => k.secretKey)).toEqual(before.map((k: { secretKey: string }) => k.secretKey));
  });

  it("si la escritura falla a mitad, la bóveda anterior sigue intacta", async () => {
    const { call, ctx, stepUp } = track(await makeApp());
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    ctx.db().exec("CREATE TRIGGER boom BEFORE UPDATE ON vault_meta BEGIN SELECT RAISE(ABORT, 'interrumpido'); END;");
    const r = await call("POST", "/api/vault/change-password", { newPassword: "nueva contraseña de prueba" }, { "x-nebula-stepup": await stepUp("change-password") });
    expect(r.status).toBe(500);
    ctx.db().exec("DROP TRIGGER boom");
    await call("POST", "/api/vault/lock");
    expect((await call("POST", "/api/vault/unlock", { password: PW })).status).toBe(200);
  });
});

describe("REQ-VAULT-005 · E2E-22 copia y restauración", () => {
  it("restaura en otra carpeta de datos con la misma contraseña; una errónea no abre la copia", async () => {
    const a = track(await makeApp());
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const created = (await a.call("POST", "/api/wallets", { count: 4, role: "holder" })).json.wallets;
    const backup = await a.call("GET", "/api/vault/backup");
    expect(backup.status).toBe(200);
    const fileB64 = Buffer.from(backup.raw).toString("base64");

    const b = track(await makeApp());
    expect((await b.call("POST", "/api/vault/restore", { fileB64, password: "contraseña equivocada" })).status).toBe(400);
    expect((await b.call("POST", "/api/vault/restore", { fileB64: Buffer.from("basura cualquiera").toString("base64"), password: PW })).status).toBe(400);
    const ok = await b.call("POST", "/api/vault/restore", { fileB64, password: PW });
    expect(ok.json).toMatchObject({ initialized: true, unlocked: true });
    const restored = (await b.call("GET", "/api/wallets")).json.wallets;
    const addrs = (l: { address: string }[]) => l.map((w) => w.address).sort();
    expect(addrs(restored)).toEqual(addrs(created));
  });
});

describe("REQ-VAULT-003 · REQ-AUTO-008 · E2E-02/14 bloqueo y pausa", () => {
  it("el bloqueo automático borra la DEK, rechaza la API y pasa las tareas RUNNING a PAUSED", async () => {
    const { call, ctx } = track(await makeApp());
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    await call("PUT", "/api/settings", { autoLockMin: 1 });
    ctx.db().prepare("INSERT INTO task(id, type, label, status, config, created_at, updated_at) VALUES('t1','dca','DCA venta KEPLER','RUNNING','{}',0,0)").run();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    ctx.vault.touch();
    ctx.vault.startAutoLock();
    expect((await call("GET", "/api/vault/status")).json.lockInSec).toBeLessThanOrEqual(60);
    vi.advanceTimersByTime(61_000);
    expect((await call("GET", "/api/vault/status")).json.unlocked).toBe(false);
    expect((await call("GET", "/api/wallets")).status).toBe(423);
    const status = () => (ctx.db().prepare("SELECT status FROM task WHERE id='t1'").get() as { status: string }).status;
    expect(status()).toBe("PAUSED");
    vi.useRealTimers();
    const st = await call("POST", "/api/vault/unlock", { password: PW });
    expect(st.json.paused).toEqual([{ id: "t1", kind: "dca", label: "DCA venta KEPLER" }]);
    expect(status()).toBe("PAUSED"); // nunca se reanuda sola
  });

  it("al reiniciar, lo que estaba RUNNING aparece PAUSED", async () => {
    const dir = tmpDir();
    const a = await makeApp(dir);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    a.ctx.db().prepare("INSERT INTO task(id, type, label, status, config, created_at, updated_at) VALUES('t2','limit','Límite','RUNNING','{}',0,0)").run();
    await a.app.close();
    const b = track(await makeApp(dir));
    expect((b.ctx.db().prepare("SELECT status FROM task WHERE id='t2'").get() as { status: string }).status).toBe("PAUSED");
  });
});
