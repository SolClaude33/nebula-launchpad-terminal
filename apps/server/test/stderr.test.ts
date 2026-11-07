// REVIEW-F1 P3-14: lo que las librerías escriben por console.error / console.log (p. ej. errores de WebSocket
// de web3.js) va directo a la terminal sin pasar por pino. Se comprueba con la salida real de un proceso hijo.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SECRET = "clave-rpc-confidencial-en-stderr-8821";

describe("REVIEW-F1 P3-14 · stdout y stderr pasan por scrub", () => {
  it("un secreto conocido que una librería imprime por console.error o console.log sale redactado", () => {
    const settings = pathToFileURL(resolve(__dirname, "../src/settings.ts")).href;
    const dir = mkdtempSync(join(tmpdir(), "nebula-stderr-"));
    const script = join(dir, "child.ts");
    writeFileSync(
      script,
      `import { installOutputScrub, remember } from ${JSON.stringify(settings)};
installOutputScrub();
remember(${JSON.stringify(SECRET)});
console.error("ws error wss://rpc.example.com/?api-key=${SECRET}");
console.warn(new Error("fallo con ${SECRET}"));
console.log("log ${SECRET}");
process.stderr.write(Buffer.from("buffer ${SECRET}\\n"));
`,
    );
    const tsx = resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");
    const r = spawnSync(process.execPath, [tsx, script], { encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("ws error");
    expect(out).toContain("buffer [redactado]");
    expect(out).not.toContain(SECRET);
  });
});
