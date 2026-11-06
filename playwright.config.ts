// Suite E2E de interfaz (TEST-ENV-005). Se lanza con `pnpm test:e2e` (scripts/e2e.mjs), que prepara una
// carpeta de datos temporal y Surfpool. Usa el Edge del sistema (sin descargar navegadores).
import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_ROOT = process.env.NEBULA_E2E_DATA ?? join(tmpdir(), "nebula-e2e");

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  // Los escenarios comparten la bóveda y la cadena local: en orden y de uno en uno
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: join(DATA_ROOT, "e2e-report.json") }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:4317",
    channel: "msedge",
    viewport: { width: 1440, height: 900 },
    locale: "es-ES",
    trace: "retain-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
    screenshot: "only-on-failure",
  },
  outputDir: join(DATA_ROOT, "results"),
  webServer: {
    command: "pnpm --filter web dev",
    url: "http://127.0.0.1:4317/unlock",
    reuseExistingServer: false,
    timeout: 180_000,
    env: { NEBULA_PROFILE: "test", NEBULA_DATA_DIR: DATA_ROOT },
    stdout: "ignore",
    stderr: "pipe",
  },
});
