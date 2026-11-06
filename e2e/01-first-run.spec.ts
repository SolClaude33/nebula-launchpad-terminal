// E2E-01 primer arranque · E2E-02 bloqueo y desbloqueo en la interfaz · E2E-21 protección del backend local
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./harness";
import { api, json, PW } from "./helpers";

test.describe.configure({ mode: "serial" });

test("E2E-01 · primer arranque: /setup crea la bóveda con el RPC local y en disco no hay nada legible", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL(/\/setup/);
  await page.locator("#pw").fill(PW);
  await page.locator("#pw2").fill(PW);
  // sin «Entiendo» no se puede crear
  await expect(page.getByRole("button", { name: "Crear bóveda" })).toBeDisabled();
  await page.getByText("RPC y clave de IPFS").click(); // desplegable opcional
  await page.locator("#rpc").fill("http://127.0.0.1:8899");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Crear bóveda" }).click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 60_000 });
  await expect(page.getByText("Tu observatorio está listo.")).toBeVisible();

  const a = await api();
  const s = await json(a, "GET", "/settings");
  // en un validador local el WebSocket va en el puerto siguiente
  expect(s).toMatchObject({ rpcPrimaryHttp: "http://127.0.0.1:8899", rpcPrimaryWs: "ws://127.0.0.1:8900" });
  // una wallet y su clave: ni la contraseña ni la clave aparecen en los archivos de la base
  const w = (await json(a, "POST", "/wallets", { count: 1, labelPrefix: "Disco" })).wallets[0];
  const tok = (await json(a, "POST", "/vault/confirm", { password: PW, action: "export-keys" })).token;
  const r = await a.post("/api/wallets/export", { data: { ids: [w.id] }, headers: { "x-nebula-stepup": tok } });
  const key = (await r.json()).keys[0].secretKey as string;
  for (const f of readdirSync(DATA_DIR).filter((f) => f.startsWith("nebula.sqlite"))) {
    const bytes = readFileSync(join(DATA_DIR, f));
    expect(bytes.includes(Buffer.from(PW)), f).toBe(false);
    expect(bytes.includes(Buffer.from(key)), f).toBe(false);
  }
});

test("E2E-02 · bloquear desde la barra, contraseña errónea con espera y desbloquear", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: /Bloquear ahora/ }).click();
  await page.waitForURL(/\/unlock/);
  // la API rechaza acciones con la bóveda bloqueada
  const a = await api();
  expect((await a.get("/api/wallets")).status()).toBe(423);
  const field = page.getByPlaceholder("••••••••••••");
  await field.fill("contraseña-equivocada-123");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Contraseña incorrecta.")).toBeVisible();
  await expect(field).toBeDisabled(); // retardo creciente
  await expect(field).toBeEnabled({ timeout: 15_000 });
  await field.fill(PW);
  await page.keyboard.press("Enter");
  await page.waitForURL((u) => !u.pathname.startsWith("/unlock")); // tras un bloqueo manual se entra al Dashboard
});

test("E2E-21 · otra web abierta en el navegador no puede usar la API local", async ({ page }) => {
  // Página de otro origen (127.0.0.1:4399) que intenta bloquear la bóveda y leer wallets
  const evil = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><script>
      window.results = {};
      fetch("http://127.0.0.1:4318/api/vault/lock", { method: "POST" }).then(r => window.results.lock = r.status, e => window.results.lock = "error");
      fetch("http://127.0.0.1:4317/api/wallets").then(r => window.results.wallets = r.status, e => window.results.wallets = "error");
    </script>`);
  });
  await new Promise<void>((r) => evil.listen(4399, "127.0.0.1", r));
  try {
    await page.goto("http://127.0.0.1:4399/");
    await expect.poll(() => page.evaluate(() => (window as unknown as { results: Record<string, unknown> }).results)).toMatchObject({ lock: expect.anything(), wallets: expect.anything() });
    const res = await page.evaluate(() => (window as unknown as { results: Record<string, unknown> }).results);
    // la petición «simple» sí llega al servidor, pero se rechaza (Origin ajeno) o el navegador no deja leerla
    expect(res.lock === 403 || res.lock === "error").toBe(true);
    expect(res.wallets === 401 || res.wallets === 403 || res.wallets === "error").toBe(true);
  } finally {
    evil.close();
  }
  const a = await api();
  expect((await json(a, "GET", "/vault/status")).unlocked).toBe(true); // nada se bloqueó
  // sin token o con Host ajeno
  const anon = await (await import("@playwright/test")).request.newContext({ baseURL: "http://127.0.0.1:4318" });
  expect((await anon.get("/api/wallets")).status()).toBe(401);
  expect((await anon.get("/api/wallets", { headers: { host: "evil.example:4318" } })).status()).toBe(403);
  expect((await a.post("/api/vault/lock", { headers: { origin: "http://evil.example" } })).status()).toBe(403);
});
