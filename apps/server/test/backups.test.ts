// §7.3: copia automática diaria de la base (con la bóveda cifrada) conservando las últimas 7; la copia
// se abre con la misma contraseña y la descarga solo acepta nombres de copias existentes.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const H = 3600_000;

describe("REVIEW-F1 P1-5 · copias tras cambiar la contraseña", () => {
  it("las copias locales con la contraseña anterior se borran y la nueva copia ya no abre con la antigua", async () => {
    const dir = tmpDir();
    const { app, ctx } = await buildApp({ profile: "test", dataDir: dir, token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
    const call = async (method: "GET" | "POST", url: string, body?: unknown, extra: Record<string, string> = {}) => {
      const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, payload: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), raw: r.rawPayload };
    };
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    await call("POST", "/api/wallets", { count: 1 });
    await ctx.backups.run(true);
    await ctx.db().backup(join(dir, "backups", `pre-restore-${Date.now()}.sqlite`));
    expect(readdirSync(join(dir, "backups"))).toHaveLength(2);
    const NEW = "otra frase larga y nueva 2026";
    const tok = (await call("POST", "/api/vault/confirm", { password: PW, action: "change-password" })).json.token;
    const r = await call("POST", "/api/vault/change-password", { newPassword: NEW }, { "x-nebula-stepup": tok });
    expect(r.json).toMatchObject({ ok: true, backupsRemoved: 2 });
    const left = readdirSync(join(dir, "backups"));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^auto-.*\.nebula-vault$/);
    // la copia que queda no abre con la contraseña anterior y sí con la nueva
    const fileB64 = readFileSync(join(dir, "backups", left[0])).toString("base64");
    for (const [pw, ok] of [[PW, false], [NEW, true]] as const) {
      const b = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
      const res = await b.app.inject({ method: "POST", url: "/api/vault/restore", headers: { host: HOST, origin: ORIGIN, "x-nebula-session": b.ctx.token, "content-type": "application/json" }, payload: JSON.stringify({ fileB64, password: pw }) });
      expect(res.statusCode === 200, pw).toBe(ok);
      await b.app.close();
    }
    expect((await call("GET", "/api/activity?kind=vault")).json.items.map((x: { kind: string }) => x.kind)).toContain("vault.backup.purge");
    await app.close();
  });
});

describe("§7.3 · copias automáticas diarias", () => {
  it("una al día como mucho, se conservan las 7 últimas y cada una se restaura con la contraseña", async () => {
    const clock = { now: Date.parse("2026-11-01T08:00:00Z") };
    const dir = tmpDir();
    const { app, ctx } = await buildApp({ profile: "test", dataDir: dir, token: "t".repeat(64), logToStdout: false, chainMode: "mock", clock: () => clock.now });
    const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
      const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.statusCode, json: (() => { try { return r.json(); } catch { return null; } })(), raw: r.rawPayload };
    };
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const w = (await call("POST", "/api/wallets", { count: 2 })).json.wallets;
    expect(await ctx.backups.run()).toMatchObject({ name: "auto-20261101-080000.nebula-vault" });
    clock.now += 5 * H;
    expect(await ctx.backups.run()).toBeNull(); // menos de 24 h desde la última
    for (let d = 1; d <= 9; d++) {
      clock.now = Date.parse("2026-11-01T08:00:00Z") + d * 24 * H + 60_000;
      expect(await ctx.backups.run()).not.toBeNull();
    }
    const list = (await call("GET", "/api/backups")).json.items as { name: string; at: number }[];
    expect(list).toHaveLength(7);
    expect(list[0].name).toBe("auto-20261110-080100.nebula-vault");
    expect(list[6].name).toBe("auto-20261104-080100.nebula-vault");
    // descargar una copia y restaurarla en otra carpeta de datos con la misma contraseña
    const dl = await call("GET", `/api/backups/${list[0].name}`);
    expect(dl.status).toBe(200);
    expect((await call("GET", "/api/backups/..%2Fnebula.sqlite")).status).toBe(404);
    expect((await call("GET", "/api/backups/auto-20261101-080000.nebula-vault")).status).toBe(404); // ya rotada
    const b = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
    const r = await b.app.inject({ method: "POST", url: "/api/vault/restore", headers: { host: HOST, origin: ORIGIN, "x-nebula-session": b.ctx.token, "content-type": "application/json" }, payload: JSON.stringify({ fileB64: Buffer.from(dl.raw).toString("base64"), password: PW }) });
    expect(r.statusCode, r.body).toBe(200);
    const restored = (await b.app.inject({ method: "GET", url: "/api/wallets", headers: { host: HOST, origin: ORIGIN, "x-nebula-session": b.ctx.token } })).json().wallets.map((x: { address: string }) => x.address);
    expect(restored).toEqual(expect.arrayContaining(w.map((x: { address: string }) => x.address)));
    // el archivo no contiene la contraseña
    expect(readFileSync(join(dir, "backups", list[0].name)).includes(Buffer.from(PW))).toBe(false);
    const act = (await call("GET", "/api/activity?kind=vault")).json.items.map((x: { kind: string }) => x.kind);
    expect(act).toContain("vault.backup.auto");
    await app.close();
    await b.app.close();
  });
});
