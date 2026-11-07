// Bloque 1 (mínimo para mainnet): ajustes con secretos en la bóveda, Pinata (contra un stub local que sigue
// su API v3 documentada) y lecturas del Live Workspace sin esperar al RPC (§7.3, p95 ≤ 50 ms).
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";
import { splitRpcKey, resolveRpcUrl, scrub } from "../src/settings";
import { PinataStore } from "../src/ipfs";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JWT = "eyJhbGciOiJIUzI1NiJ9.pinata-jwt-de-prueba-confidencial.firma123";
const SOL = 1_000_000_000n;

type Built = Awaited<ReturnType<typeof buildApp>>;
const open: { close: () => Promise<unknown> | void }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function client({ app, ctx }: Built) {
  return async (method: "GET" | "POST" | "PUT", url: string, body?: unknown) => {
    const r = await app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    let json: any;
    try {
      json = r.json();
    } catch {}
    return { status: r.statusCode, json };
  };
}

/** Stub de Pinata: POST /v3/files (multipart, Bearer, network=public) → { data: { cid } }; GET /auth. */
async function pinataStub() {
  const uploads: { name: string; network: string | null; contentType: string; body: Buffer }[] = [];
  let n = 0;
  const read = (req: IncomingMessage) => new Promise<Buffer>((res) => {
    const parts: Buffer[] = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => res(Buffer.concat(parts)));
  });
  const server: Server = createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${JWT}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { reason: "INVALID_CREDENTIALS", details: "Invalid/expired credentials" } }));
    }
    if (req.method === "GET" && req.url === "/auth") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "Congratulations! You are communicating with the Pinata API!" }));
    }
    if (req.method === "POST" && req.url === "/v3/files") {
      const body = await read(req);
      const form = await new Response(new Uint8Array(body), { headers: { "content-type": req.headers["content-type"]! } }).formData();
      const file = form.get("file") as File;
      uploads.push({ name: file.name, network: form.get("network") as string | null, contentType: file.type, body: Buffer.from(await file.arrayBuffer()) });
      const cid = `bafkrei${"a".repeat(40)}${String(++n).padStart(4, "q").replace(/\d/g, (d) => "abcdefghij"[Number(d)])}`;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: { id: randomUUID(), name: file.name, cid, size: body.length, number_of_files: 1, mime_type: file.type, group_id: null } }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  open.push({ close: () => new Promise((r) => server.close(() => r(undefined))) });
  return { uploads, endpoints: { upload: `http://127.0.0.1:${port}/v3/files`, auth: `http://127.0.0.1:${port}/auth` } };
}

describe("REQ-SET-002 · clave del RPC dentro de la bóveda", () => {
  it("separa la credencial de las URL de Helius (query) y QuickNode (ruta) y la vuelve a poner al conectar", () => {
    const h = splitRpcKey("https://mainnet.helius-rpc.com/?api-key=0f1e2d3c-aaaa-bbbb");
    expect(h).toEqual({ url: "https://mainnet.helius-rpc.com/?api-key={key}", key: "0f1e2d3c-aaaa-bbbb" });
    expect(resolveRpcUrl(h.url, h.key)).toBe("https://mainnet.helius-rpc.com/?api-key=0f1e2d3c-aaaa-bbbb");
    const q = splitRpcKey("https://dry-snowy-x.solana-mainnet.quiknode.pro/abcdef0123456789abcdef0123456789/");
    expect(q.url).toBe("https://dry-snowy-x.solana-mainnet.quiknode.pro/{key}/");
    expect(q.key).toBe("abcdef0123456789abcdef0123456789");
    expect(splitRpcKey("http://127.0.0.1:8899")).toEqual({ url: "http://127.0.0.1:8899", key: null });
    // REVIEW-F1 P2-8: credencial en el subdominio, en un segmento corto o en un parámetro con otro nombre
    const sub = splitRpcKey("https://a1b2c3d4e5f6g7h8i9.rpc.example.com/");
    expect(sub).toEqual({ url: "https://{key}.rpc.example.com/", key: "a1b2c3d4e5f6g7h8i9" });
    expect(resolveRpcUrl(sub.url, sub.key)).toBe("https://a1b2c3d4e5f6g7h8i9.rpc.example.com/");
    expect(splitRpcKey("https://rpc.example.com/v2/k3y0123456789abc")).toEqual({ url: "https://rpc.example.com/v2/{key}", key: "k3y0123456789abc" });
    const other = splitRpcKey("https://rpc.example.com/?x-credencial=9f8e7d6c5b4a39281706&net=main");
    expect(other).toEqual({ url: "https://rpc.example.com/?x-credencial={key}&net=main", key: "9f8e7d6c5b4a39281706" });
    // sin nada que parezca una clave, la URL no cambia
    expect(splitRpcKey("https://api.mainnet-beta.solana.com")).toEqual({ url: "https://api.mainnet-beta.solana.com", key: null });
    expect(splitRpcKey("https://solana-mainnet.example.com/v2")).toEqual({ url: "https://solana-mainnet.example.com/v2", key: null });
    expect(resolveRpcUrl("https://x/?api-key={key}", null)).toBeNull();
  });

  it("una URL pegada con su clave: el GET muestra {key}, ni la base ni el log la contienen; bloquear desconecta y desbloquear reconecta", async () => {
    const dir = tmpDir();
    const built = await buildApp({ profile: "mainnet", dataDir: dir, token: "t".repeat(64), logToStdout: false, chainMode: "rpc" });
    open.push(built.app);
    const call = client(built);
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const SECRET = "hel1us-key-9b8a7c6d5e4f";
    const put = await call("PUT", "/api/settings", { rpcPrimaryHttp: `https://mainnet.helius-rpc.com/?api-key=${SECRET}`, rpcPrimaryWs: `wss://mainnet.helius-rpc.com/?api-key=${SECRET}` });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json).toMatchObject({ rpcPrimaryHttp: "https://mainnet.helius-rpc.com/?api-key={key}", rpcPrimaryWs: "wss://mainnet.helius-rpc.com/?api-key={key}", rpcKeySet: true });
    expect(JSON.stringify(put.json)).not.toContain(SECRET);
    // dos claves distintas para el mismo RPC se rechazan
    expect((await call("PUT", "/api/settings", { rpcPrimaryHttp: `https://mainnet.helius-rpc.com/?api-key=${SECRET}`, rpcKey: "otra-clave-distinta" })).status).toBe(400);
    const st = (await call("GET", "/api/chain/status")).json;
    expect(st.mode).toBe("rpc");
    expect(JSON.stringify(st)).not.toContain(SECRET);
    await call("POST", "/api/vault/lock");
    const locked = (await call("GET", "/api/chain/status")).json;
    expect(locked.mode).toBe("off");
    expect(locked.error).toMatch(/Desbloquea la bóveda/);
    await call("POST", "/api/vault/unlock", { password: PW });
    expect((await call("GET", "/api/chain/status")).json.mode).toBe("rpc");
    await built.app.close();
    open.pop();
    for (const f of readdirSync(dir)) if (f.startsWith("nebula.sqlite")) expect(readFileSync(join(dir, f)).includes(Buffer.from(SECRET))).toBe(false);
    expect(readFileSync(join(dir, "logs", "nebula.log"), "utf8")).not.toContain(SECRET);
  });
});

describe("IPFS de mainnet con Pinata (stub de la API v3)", () => {
  it("sin clave, la subida se bloquea con un mensaje que explica dónde ponerla", async () => {
    const built = await buildApp({ profile: "mainnet", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
    open.push(built.app);
    const call = client(built);
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const r = await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "IPFS_UNAVAILABLE" });
    expect(r.json.message).toMatch(/Ajustes/);
  });

  it("una clave inválida da un error claro sin eco del JWT; «Probar» la valida", async () => {
    const stub = await pinataStub();
    const built = await buildApp({ profile: "mainnet", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock", ipfs: { pinata: stub.endpoints } });
    open.push(built.app);
    const call = client(built);
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    await call("PUT", "/api/settings", { ipfsKey: "jwt-equivocado-123456" });
    const bad = await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" });
    expect(bad.status).toBe(409);
    expect(bad.json.message).toMatch(/no es válida/);
    expect(JSON.stringify(bad.json)).not.toContain("jwt-equivocado");
    expect((await call("POST", "/api/settings/ipfs/test", {})).json).toMatchObject({ ok: false });
    expect((await call("POST", "/api/settings/ipfs/test", { key: JWT })).json).toMatchObject({ ok: true });
    await call("PUT", "/api/settings", { ipfsKey: JWT });
    expect((await call("POST", "/api/settings/ipfs/test", {})).json).toMatchObject({ ok: true });
    const s = (await call("GET", "/api/settings")).json;
    expect(s.ipfsKeySet).toBe(true);
    expect(JSON.stringify(s)).not.toContain(JWT);
  });

  it("lanzamiento con Pinata: imagen y JSON suben como públicos y la URI en cadena usa la pasarela", async () => {
    const stub = await pinataStub();
    // perfil test + Pinata forzado: así hay airdrop en el mock y el flujo completo es hermético
    const built = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock", ipfs: { pinata: stub.endpoints } });
    open.push(built.app);
    const call = client(built);
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    await call("PUT", "/api/settings", { ipfsKey: JWT });
    const dev = (await call("POST", "/api/wallets", { count: 1, role: "dev" })).json.wallets[0];
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 3 });
    const media = await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" });
    expect(media.status, JSON.stringify(media.json)).toBe(200);
    expect(media.json.uri).toBe(`https://ipfs.io/ipfs/${media.json.cid}`);
    await call("POST", "/api/launches/alt", { payerWalletId: dev.id });
    const draftId = `d-${randomUUID()}`;
    const v = (await call("POST", "/api/launches/preflight", { draftId, name: "Pinata Test", symbol: "PNT", description: "", imageCid: media.json.cid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: (SOL / 10n).toString(), mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true })).json;
    expect(v.preflight.ok, JSON.stringify(v.preflight)).toBe(true);
    expect(stub.uploads.map((u) => u.network)).toEqual(["public", "public"]);
    expect(stub.uploads[0].contentType).toBe("image/png");
    const meta = JSON.parse(stub.uploads[1].body.toString());
    expect(meta).toMatchObject({ name: "Pinata Test", symbol: "PNT", image: `https://ipfs.io/ipfs/${media.json.cid}` });
    expect(v.uri).toMatch(/^https:\/\/ipfs\.io\/ipfs\/bafkrei/);
    expect(v.uri.length).toBeLessThanOrEqual(200);
    await call("POST", `/api/launches/${draftId}/execute`);
    for (let i = 0; i < 100 && (await call("GET", `/api/launches/${draftId}`)).json.status !== "DONE"; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await call("GET", `/api/launches/${draftId}`)).json.status).toBe("DONE");
  });
});

describe("REVIEW-F1 P3-11 · «Probar» con una clave aún sin guardar", () => {
  it("si Pinata devuelve la clave en su respuesta, no aparece en el mensaje ni en lo que pase por scrub", async () => {
    const TYPED = "clave-pinata-escrita-sin-guardar-4711";
    // un servidor que repite la credencial en el error (el peor caso)
    const echo = (async (_u: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ error: { details: `Credencial rechazada: ${auth}` } }), { status: 401, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const store = new PinataStore(() => null, () => "https://ipfs.io/ipfs/", { upload: "http://pinata.invalid/up", auth: "http://pinata.invalid/auth" }, echo);
    const r = await store.testAuth(TYPED);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no es válida/);
    expect(r.message).not.toContain(TYPED);
    // y cualquier log posterior que la repita también sale redactado
    expect(scrub(`log con ${TYPED}`)).not.toContain(TYPED);
  });
});

describe("§7.3 · lecturas del Live Workspace con un RPC lento", () => {
  it("con 200 ms de latencia en cada llamada al RPC, el p95 de 100 lecturas de /live/:mint es ≤ 50 ms", async () => {
    const built = await buildApp({ profile: "test", dataDir: tmpDir(), token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
    open.push(built.app);
    const call = client(built);
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const dev = (await call("POST", "/api/wallets", { count: 1, role: "dev" })).json.wallets[0];
    await call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 3 });
    const img = (await call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    await call("POST", "/api/launches/alt", { payerWalletId: dev.id });
    const draftId = `d-${randomUUID()}`;
    const v = (await call("POST", "/api/launches/preflight", { draftId, name: "Lento", symbol: "SLOW", description: "", imageCid: img, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: (SOL / 10n).toString(), mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true })).json;
    await call("POST", `/api/launches/${draftId}/execute`);
    await built.ctx.launches.waitIdle(draftId);
    // RPC remoto simulado: cada lectura tarda 200 ms
    const ch = built.ctx.chain.get();
    const slow = <T extends (...a: any[]) => Promise<any>>(f: T) => (async (...a: Parameters<T>) => (await new Promise((r) => setTimeout(r, 200)), f(...a))) as T;
    ch.adapter.tokenInfo = slow(ch.adapter.tokenInfo.bind(ch.adapter));
    ch.reader.solUsd = slow(ch.reader.solUsd.bind(ch.reader));
    ch.reader.balances = slow(ch.reader.balances.bind(ch.reader));
    ch.reader.tokenBalances = slow(ch.reader.tokenBalances.bind(ch.reader));
    ch.reader.signatures = slow(ch.reader.signatures.bind(ch.reader));
    // primera lectura (calienta el vigilante): puede esperar al RPC
    expect((await call("GET", `/api/live/${v.mint}`)).status).toBe(200);
    await call("GET", `/api/live/${v.mint}/position`);
    const times: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      const t = performance.now();
      const path = i % 3 === 0 ? `/api/live/${v.mint}/position` : `/api/live/${v.mint}?after=0`;
      expect((await call("GET", path)).status).toBe(200);
      times.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 25)); // ~2,5 s de sondeo: los TTL caducan varias veces
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    expect(Date.now() - t0).toBeGreaterThan(2000);
    expect(p95, `p95 = ${p95.toFixed(1)} ms`).toBeLessThanOrEqual(50);
  }, 30_000);
});
