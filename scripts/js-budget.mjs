// §8.6: presupuesto de JS inicial (≤ 300 KB gzip). Arranca el build de producción de la web (`next start`)
// y, en Edge, mide los bytes de JavaScript transferidos (comprimidos) en la carga inicial de cada ruta.
// Uso: `pnpm build && node scripts/js-budget.mjs` (con 4317 libre). No necesita la API: solo cuenta JS.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const BUDGET = 300 * 1024;
const ROUTES = ["/unlock", "/setup", "/", "/wallets", "/launch/new", "/launches", "/t/So11111111111111111111111111111111111111112", "/automations", "/rewards", "/settings", "/activity"];
const open = (p) => new Promise((r) => {
  const s = connect({ host: "127.0.0.1", port: p });
  s.once("connect", () => (s.destroy(), r(true)));
  s.once("error", () => r(false));
});

if (await open(4317)) {
  console.error("El puerto 4317 está ocupado.");
  process.exit(1);
}
const web = spawn("pnpm", ["--filter", "web", "start"], { shell: true, stdio: "ignore", env: { ...process.env, NEBULA_DATA_DIR: mkdtempSync(join(tmpdir(), "nebula-budget-")) }, windowsHide: true });
for (let i = 0; i < 120 && !(await open(4317)); i++) await new Promise((r) => setTimeout(r, 500));

const browser = await chromium.launch({ channel: "msedge" });
const rows = [];
try {
  for (const route of ROUTES) {
    const ctx = await browser.newContext({ extraHTTPHeaders: { "accept-encoding": "gzip" } });
    const page = await ctx.newPage();
    const seen = new Map();
    page.on("requestfinished", async (req) => {
      if (req.resourceType() !== "script") return;
      const s = await req.sizes().catch(() => null);
      if (s) seen.set(req.url(), s.responseBodySize);
    });
    await page.goto(`http://127.0.0.1:4317${route}`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    const bytes = [...seen.values()].reduce((a, b) => a + b, 0);
    rows.push({ route, scripts: seen.size, kb: Math.round(bytes / 102.4) / 10 });
    await ctx.close();
  }
} finally {
  await browser.close();
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(web.pid), "/T", "/F"], { stdio: "ignore" });
  else web.kill();
}
const worst = Math.max(...rows.map((r) => r.kb));
console.log("| Ruta | Scripts | JS inicial (KB comprimido) |\n|---|---|---|");
for (const r of rows) console.log(`| ${r.route} | ${r.scripts} | ${r.kb.toLocaleString("es-ES")} |`);
console.log(`\nMáximo: ${worst.toLocaleString("es-ES")} KB de ${BUDGET / 1024} KB → ${worst * 1024 <= BUDGET ? "dentro del presupuesto" : "FUERA del presupuesto"}`);
process.exit(worst * 1024 <= BUDGET ? 0 : 1);
