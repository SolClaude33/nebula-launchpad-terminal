// Arranca Nébula en el perfil mainnet (bóveda y datos en ~/.nebula/mainnet, separados de pruebas).
// Construye la web y lanza la API y la web en modo producción con NEBULA_PROFILE=mainnet.
import { spawnSync } from "node:child_process";
const env = { ...process.env, NEBULA_PROFILE: "mainnet" };
const run = (args) => {
  const r = spawnSync("pnpm", args, { stdio: "inherit", shell: true, env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (!process.argv.includes("--no-build")) run(["build"]);
run(["start"]);
