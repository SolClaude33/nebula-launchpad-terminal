// REQ-LAUNCH-004 / E2E-08 (parte de la API): el borrador vive en SQLite y sobrevive a un reinicio de la app.
// REQ-LAUNCH-020: archivar lanzamientos.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app";
import { HOST, ORIGIN, PW, tmpDir } from "./helpers";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function open(dataDir: string) {
  const built = await buildApp({ profile: "test", dataDir, token: "t".repeat(64), logToStdout: false, chainMode: "mock" });
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) => {
    const r = await built.app.inject({ method, url, headers: { host: HOST, origin: ORIGIN, "x-nebula-session": built.ctx.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  };
  return { ...built, call };
}

describe("REQ-LAUNCH-004 · borradores en el servidor", () => {
  it("E2E-08 · un borrador a medias sobrevive a reiniciar la app y se retoma sin perder datos", async () => {
    const dir = tmpDir();
    let a = await open(dir);
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const id = `d-${randomUUID()}`;
    const data = { draftId: id, name: "Medio Hecho", symbol: "HALF", description: "Descripción a medias", links: { x: "https://x.com/half", telegram: "", web: "" }, devBuy: "0,25", plan: ["w1", "w2"], image: { name: "a.png", size: 70, type: "image/png", url: `data:image/png;base64,${PNG}` }, upload: { status: "done", progress: 100, cid: "local-abc" } };
    expect((await a.call("PUT", `/api/drafts/${id}`, data)).status).toBe(200);
    // un id raro o un cuerpo que no es objeto se rechazan
    expect((await a.call("PUT", "/api/drafts/../x", data)).status).toBe(404);
    expect((await a.call("PUT", `/api/drafts/${id}`, ["no"])).status).toBe(400);
    await a.app.close();

    a = await open(dir);
    await a.call("POST", "/api/vault/unlock", { password: PW });
    const list = (await a.call("GET", "/api/drafts")).json.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: "Medio Hecho", symbol: "HALF", launch: null });
    expect(list[0].image).toMatch(/^data:image\/png/);
    expect((await a.call("GET", "/api/drafts/latest")).json.draft.id).toBe(id);
    expect((await a.call("GET", `/api/drafts/${id}`)).json.data).toEqual(data);
    // con la bóveda bloqueada no se leen
    await a.call("POST", "/api/vault/lock");
    expect((await a.call("GET", "/api/drafts")).status).toBe(423);
    await a.call("POST", "/api/vault/unlock", { password: PW });
    expect((await a.call("DELETE", `/api/drafts/${id}`)).status).toBe(200);
    expect((await a.call("GET", "/api/drafts")).json.items).toHaveLength(0);
    await a.app.close();
  });

  it("un borrador lanzado sale de Borradores y aparece en /launches; se puede archivar", async () => {
    const a = await open(tmpDir());
    await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
    const dev = (await a.call("POST", "/api/wallets", { count: 1, role: "dev" })).json.wallets[0];
    await a.call("POST", "/api/dev/airdrop", { walletIds: [dev.id], sol: 2 });
    const imageCid = (await a.call("POST", "/api/launches/media", { fileB64: PNG, contentType: "image/png" })).json.cid;
    await a.call("POST", "/api/launches/alt", { payerWalletId: dev.id });
    const id = `d-${randomUUID()}`;
    await a.call("PUT", `/api/drafts/${id}`, { draftId: id, name: "Lanzado", symbol: "GONE" });
    const cfg = { draftId: id, name: "Lanzado", symbol: "GONE", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: "100000000", mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true };
    expect((await a.call("POST", "/api/launches/preflight", cfg)).json.preflight.ok).toBe(true);
    // con el dry-run preparado sigue siendo un borrador
    expect((await a.call("GET", "/api/drafts")).json.items.map((d: { id: string }) => d.id)).toEqual([id]);
    await a.call("POST", `/api/launches/${id}/execute`, {});
    await a.ctx.launches.waitIdle(id);
    expect((await a.call("GET", "/api/drafts")).json.items).toHaveLength(0);
    const all = (await a.call("GET", "/api/launches?all=1")).json.items;
    expect(all[0]).toMatchObject({ id, status: "DONE", symbol: "GONE", mode: "manual" });
    expect((await a.call("POST", `/api/launches/${id}/archive`, { archived: true })).status).toBe(200);
    expect((await a.call("GET", "/api/launches?all=1")).json.items).toHaveLength(0);
    expect((await a.call("GET", "/api/launches?all=1&archived=1")).json.items).toHaveLength(1);
    await a.app.close();
  });
});
