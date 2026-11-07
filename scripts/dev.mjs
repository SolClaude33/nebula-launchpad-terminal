// `pnpm dev`: la API (tsx watch, 127.0.0.1:4318) y la web (next dev, 127.0.0.1:4317) a la vez.
//
// Antes era `pnpm -r --parallel --filter server --filter web dev`. En Windows, `tsx watch` lanzado por el
// ejecutor paralelo de pnpm no llega a arrancar la API (no imprime nada y no escucha en el 4318). Medido el
// 2026-11-07: `pnpm --filter server dev`, `pnpm -r --filter server dev` y `tsx watch` directo arrancan en
// ~2 s; `pnpm -r --parallel --filter server dev` no arranca ni en 40 s. Aquí cada app se lanza con su propio
// `pnpm --filter <app> dev`, la salida se prefija como hacía pnpm y al salir se paran los dos árboles.
import { spawn, spawnSync } from "node:child_process";

const win = process.platform === "win32";
const APPS = [
  { name: "server", color: "\x1b[35m" },
  { name: "web", color: "\x1b[36m" },
];

const killTree = (child) => {
  if (child.exitCode !== null || !child.pid) return;
  if (win) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
};

const children = APPS.map(({ name, color }) => {
  const child = spawn("pnpm", ["--filter", name, "dev"], { stdio: ["ignore", "pipe", "pipe"], shell: win, env: process.env, windowsHide: true });
  const prefix = process.stdout.isTTY ? `${color}apps/${name} dev:\x1b[0m ` : `apps/${name} dev: `;
  for (const [src, dst] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    let buf = "";
    src.setEncoding("utf8");
    src.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) dst.write(`${prefix}${line}\n`);
    });
    src.on("end", () => buf && dst.write(`${prefix}${buf}\n`));
  }
  return { name, child };
});

let stopping = false;
const stop = (code) => {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) killTree(child);
  process.exit(code);
};

for (const { name, child } of children) {
  child.on("exit", (code, signal) => {
    if (stopping) return;
    process.stderr.write(`apps/${name} dev terminó (${signal ?? code}); se para el resto.\n`);
    stop(code ?? 1);
  });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
