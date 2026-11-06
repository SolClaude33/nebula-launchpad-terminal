import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { assertProfileRpc, ChainConfigError } from "../src/chain";
import { RpcPool } from "../src/chain/rpc";
import { classify } from "../src/chain/sender";

// Stub mínimo de JSON-RPC que responde a getSlot: el «RPC de respaldo»
let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id } = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: 4242 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("NFR-TX-002 · E2E-20 failover de RPC", () => {
  it("si el principal está caído, pasa al de respaldo en ≤ 3 s", async () => {
    const pool = new RpcPool([{ http: "http://127.0.0.1:1" }, { http: `http://127.0.0.1:${port}` }], 1000);
    const t = Date.now();
    const slot = await pool.run((c) => c.getSlot());
    expect(slot).toBe(4242);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(pool.status()).toMatchObject({ usingBackup: true, healthy: true });
  });

  it("los health checks devuelven el tráfico al principal cuando vuelve", async () => {
    const pool = new RpcPool([{ http: `http://127.0.0.1:${port}` }, { http: "http://127.0.0.1:1" }], 1000);
    await pool.check();
    expect(pool.status()).toMatchObject({ usingBackup: false, healthy: true });
  });
});

describe("Perfil de pruebas", () => {
  it("rechaza un RPC que no sea local (un fork de mainnet se parece a mainnet)", () => {
    expect(() => assertProfileRpc("test", [{ http: "https://api.mainnet-beta.solana.com" }])).toThrow(ChainConfigError);
    expect(() => assertProfileRpc("test", [{ http: "http://127.0.0.1:8899", ws: "wss://evil.example" }])).toThrow(ChainConfigError);
    expect(() => assertProfileRpc("test", [{ http: "http://127.0.0.1:8899" }])).not.toThrow();
    expect(() => assertProfileRpc("mainnet", [{ http: "https://api.mainnet-beta.solana.com" }])).not.toThrow();
  });
});

describe("Clasificación de errores de envío", () => {
  it("reconoce slippage (6002/6003), curva completa y saldo insuficiente", () => {
    expect(classify(["Program log: AnchorError … Error Code: TooMuchSolRequired. Error Number: 6002."], { InstructionError: [2, { Custom: 6002 }] }).code).toBe("SLIPPAGE");
    expect(classify(["custom program error: 0x1773"], null).code).toBe("SLIPPAGE");
    expect(classify(["custom program error: 0x1775"], null).code).toBe("CURVE_COMPLETE");
    expect(classify(["Transfer: insufficient lamports 100, need 200"], null).code).toBe("INSUFFICIENT_FUNDS");
  });
});
