// Validador local para el perfil `test` (TEST-ENV-001): Surfpool como fork perezoso de mainnet.
// Uso: `pnpm surfpool:install` una vez; luego `pnpm surfpool` (RPC en 127.0.0.1:8899, WS en 8900).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const VERSION = "1.6.1";
// Hash publicado por GitHub para el asset oficial (solana-foundation/surfpool, v1.6.1)
const ASSETS = {
  win32: { name: "surfpool-windows-x64.tar.gz", sha256: "42ba2ac818641d65deea2c1c2018bea94f56a25256a6ed03c6ce81605d76c937", bin: "surfpool.exe" },
};
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".tools", `surfpool-${VERSION}`);
const asset = ASSETS[process.platform];
const bin = asset ? join(dir, asset.bin) : null;

async function install() {
  if (!asset) throw new Error(`Plataforma ${process.platform} sin asset fijado; añade su hash a scripts/surfpool.mjs.`);
  if (existsSync(bin)) return console.log(`Surfpool ${VERSION} ya está en ${dir}`);
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/solana-foundation/surfpool/releases/download/v${VERSION}/${asset.name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Descarga fallida: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== asset.sha256) throw new Error(`SHA-256 no coincide (${got}). No se instala.`);
  const tgz = join(dir, asset.name);
  writeFileSync(tgz, buf);
  // Ruta relativa: el tar de Git Bash interpreta "C:" como host remoto
  execFileSync("tar", ["-xzf", asset.name], { cwd: dir });
  rmSync(tgz);
  console.log(`Surfpool ${VERSION} instalado y verificado en ${dir}`);
}

function start() {
  if (!bin || !existsSync(bin)) throw new Error("Surfpool no está instalado. Ejecuta `pnpm surfpool:install`.");
  const args = ["start", "--network", "mainnet", "--host", "127.0.0.1", "--no-tui", "--no-studio", "--no-deploy", "--airdrop-amount", "0", "--db", ":memory:"];
  spawn(bin, args, { stdio: "inherit", cwd: dir }).on("exit", (c) => process.exit(c ?? 0));
}

if (process.argv[2] === "install") install().catch((e) => (console.error(e.message), process.exit(1)));
else start();
