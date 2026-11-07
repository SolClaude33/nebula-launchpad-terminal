// Ejecuta la suite de contrato también contra Surfpool (necesita `pnpm surfpool` corriendo en 127.0.0.1:8899).
import { spawnSync } from "node:child_process";
const ping = await fetch("http://127.0.0.1:8899", { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' }).catch(() => null);
if (!ping?.ok) {
  console.error("Surfpool no responde en 127.0.0.1:8899. Arráncalo con `pnpm surfpool` en la raíz.");
  process.exit(1);
}
const r = spawnSync("pnpm", ["exec", "vitest", "run", "--no-file-parallelism", "--test-timeout=180000", "test/contract.test.ts", "test/operations.test.ts", "test/launch.test.ts", "test/live.test.ts", "test/automations.test.ts", "test/dashboard.test.ts", "test/tokens.test.ts", "test/guard.test.ts", "test/jito.test.ts"], { stdio: "inherit", shell: true, env: { ...process.env, NEBULA_CHAIN_TESTS: "1" } });
process.exit(r.status ?? 1);
