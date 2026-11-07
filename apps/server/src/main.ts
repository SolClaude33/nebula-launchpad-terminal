import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { API_PORT } from "@nebula/shared";
import { currentProfile, dataDir, sessionTokenPath } from "@nebula/shared/node";
import { buildApp } from "./app";
import { installOutputScrub } from "./settings";

// lo que las librerías escriban por la terminal también pasa por la redacción (REVIEW-F1 P3-14)
installOutputScrub();

const profile = currentProfile();
const dir = dataDir(profile);
const { app, ctx } = await buildApp({ profile, dataDir: dir });

// El token de sesión se genera en cada arranque y solo lo lee el servidor de Next (misma máquina, mismo usuario).
const tokenFile = sessionTokenPath(profile);
mkdirSync(dirname(tokenFile), { recursive: true });
writeFileSync(tokenFile, ctx.token, { mode: 0o600 });
try {
  chmodSync(tokenFile, 0o600);
} catch {}

ctx.vault.startAutoLock();
// §7.3: copia automática diaria de la base (con la bóveda cifrada dentro); se conservan las últimas 7
ctx.backups.start();

// NFR-SEC-003: solo 127.0.0.1, nunca 0.0.0.0
await app.listen({ host: "127.0.0.1", port: Number(process.env.NEBULA_API_PORT ?? API_PORT) });
app.log.info({ profile, dataDir: dir }, "Nébula API lista");

const shutdown = async () => {
  rmSync(tokenFile, { force: true });
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
