// Arnés de la suite E2E de interfaz (TEST-ENV-005/006). La API la posee el lanzador `scripts/e2e.mjs`
// (un proceso Node normal): los escenarios le piden arrancarla, pararla o reiniciarla por un control
// local en 127.0.0.1:4390. Así «cerrar y abrir la app» (E2E-08, E2E-09) no depende del ciclo de vida
// de los workers de Playwright, que en Windows terminaban la API relanzada desde ellos.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

export const ROOT = join(__dirname, "..");
export const DATA_ROOT = process.env.NEBULA_E2E_DATA ?? join(tmpdir(), "nebula-e2e");
export const DATA_DIR = join(DATA_ROOT, "test");
export const PW = "correct horse battery staple";

export const portOpen = (port: number) =>
  new Promise<boolean>((res) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
    s.setTimeout(800, () => (s.destroy(), res(false)));
  });

async function control(op: "start" | "stop" | "restart") {
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:4390/${op}`, { signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new Error("No hay control de la API en 127.0.0.1:4390: lanza la suite con `pnpm test:e2e`.");
  }
  if (!r.ok) throw new Error(`Control de la API (${op}): ${await r.text()}`);
}

export const startApi = () => control("start");
export const stopApi = () => control("stop");
/** «Cerrar y abrir la app»: la API arranca de nuevo con la misma carpeta de datos (bóveda bloqueada). */
export const restartApi = () => control("restart");

export const sessionToken = () => readFileSync(join(DATA_DIR, "run", "session-token"), "utf8").trim();
