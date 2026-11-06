import { afterEach, describe, expect, it } from "vitest";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp, PW } from "./helpers";

type App = Awaited<ReturnType<typeof makeApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.app.close();
});

describe("NFR-SEC-003 · E2E-21 protección de la API local", () => {
  it("rechaza sin token, con Host ajeno (DNS rebinding) y con Origin ajeno", async () => {
    const a = await makeApp();
    apps.push(a);
    const tok = a.ctx.token;
    const inj = (headers: Record<string, string>, method: "GET" | "POST" = "GET") => a.app.inject({ method, url: "/api/vault/status", headers }).then((r) => r.statusCode);
    expect(await inj({ host: "127.0.0.1:4318" })).toBe(401);
    expect(await inj({ host: "127.0.0.1:4318", "x-nebula-session": "x".repeat(64) })).toBe(401);
    expect(await inj({ host: "evil.example:4318", "x-nebula-session": tok })).toBe(403);
    expect(await inj({ host: "127.0.0.1:4318", origin: "https://evil.example", "x-nebula-session": tok })).toBe(403);
    expect(await inj({ host: "127.0.0.1:4318", "x-nebula-session": tok }, "POST")).toBe(403); // mutación sin Origin
    expect(await inj({ host: "127.0.0.1:4318", "x-nebula-session": tok })).toBe(200);
  });

  it("solo escucha en loopback: la IP de la red local no responde", async () => {
    const a = await makeApp();
    apps.push(a);
    await a.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (a.app.server.address() as { port: number }).port;
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    expect(lan, "no hay interfaz de red externa para probar").toBeTruthy();
    const result = await new Promise<string>((res) => {
      const s = connect({ host: lan!, port, timeout: 1500 });
      s.on("connect", () => (s.destroy(), res("open")));
      s.on("error", (e: NodeJS.ErrnoException) => res(e.code ?? "error"));
      s.on("timeout", () => (s.destroy(), res("timeout")));
    });
    expect(result).not.toBe("open");
  });
});

describe("NFR-SEC-004 · E2E-17 nada secreto en los logs", () => {
  it("tras exportar claves y fallar contraseñas, el log no contiene claves, contraseñas ni el token", async () => {
    const a = await makeApp();
    apps.push(a);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const ids = (await a.call("POST", "/api/wallets", { count: 2 })).json.created;
    await a.call("POST", "/api/vault/confirm", { password: "contraseña-mala-xyz", action: "export-keys" });
    await new Promise((r) => setTimeout(r, 2100)); // retardo tras el fallo
    const keys = (await a.call("POST", "/api/wallets/export", { ids }, { "x-nebula-stepup": await a.stepUp("export-keys") })).json.keys as { secretKey: string }[];
    await a.call("PUT", "/api/settings", { rpcKey: "helius-api-key-confidencial" });
    // Aunque alguien intente registrar secretos por error, la redacción los tapa
    a.app.log.info({ password: PW, keys, body: { secretKey: keys[0].secretKey } }, "intento de registrar secretos");
    const log = readFileSync(join(a.dataDir, "logs", "nebula.log"), "utf8");
    expect(log.length).toBeGreaterThan(0);
    for (const k of keys) expect(log).not.toContain(k.secretKey);
    for (const s of [PW, "contraseña-mala-xyz", "helius-api-key-confidencial", a.ctx.token]) expect(log).not.toContain(s);
    expect(log).toContain("[redactado]");
    const activity = (await a.call("GET", "/api/activity")).json.items as { kind: string }[];
    expect(activity.some((i) => i.kind === "wallets.export")).toBe(true);
  });
});
