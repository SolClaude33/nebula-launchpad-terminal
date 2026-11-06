// TEST-ENV-006: `pnpm test:e2e` prepara todo y ejecuta la suite de interfaz.
// 1) comprueba que 4317/4318 están libres, 2) vacía la carpeta de datos temporal de la suite,
// 3) arranca Surfpool si no está corriendo (y lo para al final), 4) gestiona el proceso de la API y
// 5) lanza Playwright. La API la posee este proceso (no los workers de Playwright): un control local en
// 127.0.0.1:4390 la arranca, la para y la reinicia (E2E-08/09 «cerrar y abrir la app»).
// Los seeds (wallets financiadas, tokens lanzados) los crea cada escenario por la API local.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const open = (port) =>
  new Promise((res) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });
const waitFor = async (fn, ms) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
const killTree = (pid) => (process.platform === "win32" ? spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }) : process.kill(pid, "SIGKILL"));

for (const p of [4317, 4318, 4390]) {
  if (await open(p)) {
    console.error(`El puerto ${p} está ocupado: para \`pnpm dev\` (o la suite anterior) antes de la suite E2E.`);
    process.exit(1);
  }
}

const dataRoot = process.env.NEBULA_E2E_DATA ?? join(tmpdir(), "nebula-e2e");
rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });

// ── API ─────────────────────────────────────────
let api = null;
async function startApi() {
  if (await open(4318)) throw new Error("4318 ocupado");
  const stamp = Date.now();
  api = spawn(process.execPath, [join(ROOT, "apps", "server", "node_modules", "tsx", "dist", "cli.mjs"), "src/main.ts"], {
    cwd: join(ROOT, "apps", "server"),
    env: { ...process.env, NEBULA_PROFILE: "test", NEBULA_DATA_DIR: dataRoot },
    stdio: ["ignore", openSync(join(dataRoot, `api-${stamp}.log`), "a"), openSync(join(dataRoot, `api-${stamp}.err.log`), "a")],
    windowsHide: true,
  });
  if (!(await waitFor(() => open(4318), 60_000))) throw new Error("La API no arrancó");
}
async function stopApi() {
  if (api) killTree(api.pid);
  api = null;
  await waitFor(async () => !(await open(4318)), 20_000);
}

const control = createServer(async (req, res) => {
  try {
    if (req.url === "/start") await startApi();
    else if (req.url === "/stop") await stopApi();
    else if (req.url === "/restart") (await stopApi(), await startApi());
    else return res.writeHead(404).end();
    res.writeHead(200).end("ok");
  } catch (e) {
    res.writeHead(500).end(String(e?.message ?? e));
  }
});
await new Promise((r) => control.listen(4390, "127.0.0.1", r));

// ── Surfpool ────────────────────────────────────
let surfpool = null;
if (!(await open(8899))) {
  console.log("Arrancando Surfpool…");
  surfpool = spawn(process.execPath, ["scripts/surfpool.mjs"], { stdio: "ignore", windowsHide: true });
  if (!(await waitFor(() => open(8899), 60_000))) {
    console.error("Surfpool no arrancó (¿falta `pnpm surfpool:install`?).");
    process.exit(1);
  }
}

// Playwright se lanza de forma asíncrona para que el control siga atendiendo peticiones
const args = process.argv.slice(2);
const pw = spawn("pnpm", ["exec", "playwright", "test", ...args], { stdio: "inherit", shell: true, env: { ...process.env, NEBULA_E2E_DATA: dataRoot } });
const code = await new Promise((r) => pw.on("exit", (c) => r(c ?? 1)));

await stopApi();
control.close();
if (surfpool) killTree(surfpool.pid);
process.exit(code);
