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

describe("Errores transitorios del RPC", () => {
  it("reintenta un «Internal error» y devuelve el resultado", async () => {
    const pool = new RpcPool([{ http: "http://127.0.0.1:1" }]);
    let calls = 0;
    const r = await pool.run(async () => {
      calls++;
      if (calls < 3) throw new Error("failed to get info for accounts X: Internal error");
      return 7;
    });
    expect(r).toBe(7);
    expect(calls).toBe(3);
  });
});

describe("REVIEW-F1 P1-4 · límites del proveedor (Helius Free) y 429", () => {
  // Stub con contadores: getSlot normal; sendTransaction responde 429 las primeras `fail429` veces
  const mk = async (fail429 = 0) => {
    const hits: { method: string; at: number }[] = [];
    const batches: number[] = [];
    let left = fail429;
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msgs = JSON.parse(body);
        const batch = Array.isArray(msgs) ? msgs : [msgs];
        for (const m of batch) hits.push({ method: m.method, at: Date.now() });
        batches.push(batch.length);
        if (batch[0].method === "sendTransaction" && left > 0) {
          left--;
          res.statusCode = 429;
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32005, message: "Too many requests" }, id: batch[0].id }));
        }
        const out = batch.map((m) => ({ jsonrpc: "2.0", id: m.id, result: m.method === "sendTransaction" ? "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYVCJjBRAHtKJQKQMFZkr5abPwnRoSLRp6jg5Yzm2LZ6mjKQtz7yWc" : m.method === "getTransaction" ? null : 4242 }));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(msgs) ? out : out[0]));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    return { srv, hits, batches, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
  };

  it("con 10 peticiones/s, 25 lecturas a la vez tardan ≥ 1,4 s y nunca hay más de 10 en una ventana de 1 s (más la ráfaga inicial)", async () => {
    const s = await mk();
    const pool = new RpcPool([{ http: s.url }], 1000, { rps: 10 });
    const t = Date.now();
    await Promise.all(Array.from({ length: 25 }, () => pool.run((c) => c.getSlot())));
    expect(Date.now() - t).toBeGreaterThanOrEqual(1400);
    const at = s.hits.map((h) => h.at);
    for (const a of at) expect(at.filter((b) => b > a + 1000 - 1 && b <= a + 2000).length).toBeLessThanOrEqual(11);
    s.srv.close();
  });

  it("sendTransaction a 1/s: tres envíos se espacian ≥ 1 s; un 429 al enviar se reintenta con la misma transacción", async () => {
    const s = await mk(2);
    const pool = new RpcPool([{ http: s.url }], 1000, { sendRps: 1 });
    const raw = Buffer.alloc(200, 1);
    // el 429 lo absorben los reintentos del pool (1 s y 2 s): el tercer intento entra
    const sig = await pool.run((c) => c.sendRawTransaction(raw, { skipPreflight: true }), { send: true });
    expect(sig).toMatch(/^5VER/);
    expect(s.hits.filter((h) => h.method === "sendTransaction")).toHaveLength(3);
    const t = Date.now();
    await pool.run((c) => c.sendRawTransaction(raw, { skipPreflight: true }), { send: true });
    await pool.run((c) => c.sendRawTransaction(raw, { skipPreflight: true }), { send: true });
    expect(Date.now() - t).toBeGreaterThanOrEqual(1800);
    s.srv.close();
  }, 20_000);

  it("un lote de 25 firmas sale en lotes de 10 como máximo (un lote cuenta como N peticiones)", async () => {
    const s = await mk();
    const { createChain } = await import("../src/chain");
    const chain = createChain({ profile: "mainnet", mode: "rpc", endpoints: [{ http: s.url }], db: () => null as never, sign: () => new Uint8Array(), priorityMicroLamports: () => 1, limits: { rps: 100 } });
    await chain.reader.transactions(Array.from({ length: 25 }, (_, i) => `sig${i}`));
    chain.stop();
    // tres lotes: 10 + 10 + 5 getTransaction (cada lote llega en una petición HTTP)
    expect(s.hits.filter((h) => h.method === "getTransaction")).toHaveLength(25);
    expect(Math.max(...s.batches)).toBeLessThanOrEqual(10);
    s.srv.close();
  });
});

describe("REVIEW-F1 P2-7 · holders en mainnet", () => {
  it("si getTokenLargestAccounts falla (429), no se recurre a getProgramAccounts", async () => {
    const methods: string[] = [];
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = JSON.parse(body);
        methods.push(m.method);
        res.setHeader("content-type", "application/json");
        if (m.method === "getTokenLargestAccounts") {
          res.statusCode = 429;
          return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32005, message: "Too many requests" }, id: m.id }));
        }
        if (m.method === "getAccountInfo")
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { context: { slot: 1 }, value: { data: ["", "base64"], executable: false, lamports: 1, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", rentEpoch: 0, space: 0 } } }));
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: 1 }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { createChain } = await import("../src/chain");
    const chain = createChain({ profile: "mainnet", mode: "rpc", endpoints: [{ http: `http://127.0.0.1:${(srv.address() as { port: number }).port}` }], db: () => null as never, sign: () => new Uint8Array(), priorityMicroLamports: () => 1 });
    const h = await chain.reader.holders("So11111111111111111111111111111111111111112");
    chain.stop();
    srv.close();
    expect(h).toEqual({ complete: false, items: [] });
    expect(methods).toContain("getTokenLargestAccounts");
    expect(methods).not.toContain("getProgramAccounts");
  });
});
