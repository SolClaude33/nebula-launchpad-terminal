import { afterEach, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import { makeApp, PW } from "./helpers";
import { b58encode } from "../src/base58";

type App = Awaited<ReturnType<typeof makeApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.app.close();
});
const ready = async () => {
  const a = await makeApp();
  apps.push(a);
  await a.call("POST", "/api/vault/setup", { password: PW, ack: true });
  return a;
};
type W = { id: string; role: string | null; folderIds: string[]; kind: string; isDefaultFunder: boolean };

describe("REQ-WAL-001/003/004 · E2E-03", () => {
  it("crea 10, las mete en una carpeta, asigna rol y admite varias carpetas", async () => {
    const { call } = await ready();
    expect((await call("POST", "/api/wallets", { count: 101 })).status).toBe(400);
    const folder = (await call("POST", "/api/folders", { name: "Holders A" })).json.folders[0];
    const r = await call("POST", "/api/wallets", { count: 10, role: "holder", folderId: folder.id });
    expect(r.json.created).toHaveLength(10);
    const second = (await call("POST", "/api/folders", { name: "Lote 2" })).json.folders[1];
    await call("POST", `/api/folders/${second.id}/members`, { walletIds: r.json.created.slice(0, 3), op: "add" });
    const ws: W[] = (await call("GET", "/api/wallets")).json.wallets;
    expect(ws.filter((w) => w.folderIds.includes(folder.id))).toHaveLength(10);
    expect(ws.filter((w) => w.folderIds.length === 2)).toHaveLength(3);
    expect(ws.every((w) => w.role === "holder")).toBe(true);
    expect((await call("PATCH", "/api/wallets", { ids: [ws[0].id], role: "Mal Rol" })).status).toBe(400);
    expect((await call("PATCH", "/api/wallets", { ids: [ws[0].id], role: "sniper_2" })).status).toBe(200);
  });
});

describe("REQ-WAL-002 · importación", () => {
  it("acepta base58 de 64 bytes, seed de 32 y array JSON; marca duplicadas e inválidas por fila", async () => {
    await sodium.ready;
    const k1 = sodium.crypto_sign_keypair();
    const k2 = sodium.crypto_sign_keypair();
    const seed = sodium.randombytes_buf(32);
    const bad = new Uint8Array(k1.privateKey);
    bad[40] ^= 1; // la parte pública ya no corresponde
    const text = [b58encode(k1.privateKey), JSON.stringify([...k2.privateKey]), b58encode(seed), b58encode(k1.privateKey), "no-es-una-clave-0OIl", b58encode(bad), "# comentario", ""].join("\n");
    const { call } = await ready();
    const rows = (await call("POST", "/api/wallets/import", { text, role: "trading" })).json.rows;
    expect(rows.map((r: { status: string }) => r.status)).toEqual(["imported", "imported", "imported", "duplicate", "invalid", "invalid"]);
    expect(rows[0].address).toBe(b58encode(k1.publicKey));
  });
});

describe("REQ-FUND-001/004 · funders", () => {
  it("siempre hay un predeterminado y no se puede borrar ni archivar", async () => {
    const { call, stepUp } = await ready();
    const f: W[] = (await call("POST", "/api/wallets", { count: 2, kind: "funder" })).json.wallets.filter((w: W) => w.kind === "funder");
    const def = f.find((w) => w.isDefaultFunder)!;
    expect(f.filter((w) => w.isDefaultFunder)).toHaveLength(1);
    expect((await call("PATCH", "/api/wallets", { ids: [def.id], archived: true })).status).toBe(409);
    expect((await call("DELETE", "/api/wallets", { ids: [def.id] }, { "x-nebula-stepup": await stepUp("delete-wallet") })).status).toBe(409);
    const other = f.find((w) => !w.isDefaultFunder)!;
    await call("POST", "/api/funders/default", { id: other.id });
    expect((await call("DELETE", "/api/wallets", { ids: [def.id] }, { "x-nebula-stepup": await stepUp("delete-wallet") })).status).toBe(200);
  });
});

describe("REQ-SET-002 · secretos de ajustes", () => {
  it("la clave de IPFS se guarda cifrada y el GET nunca la devuelve", async () => {
    const { call, ctx } = await ready();
    const s = await call("PUT", "/api/settings", { ipfsKey: "pinata-jwt-super-secreto-123", slippageBuyPct: 12 });
    expect(s.json).toMatchObject({ ipfsKeySet: true, slippageBuyPct: 12 });
    expect(JSON.stringify(s.json)).not.toContain("pinata-jwt");
    const raw = ctx.db().prepare("SELECT ciphertext FROM setting_secret WHERE name='ipfsKey'").get() as { ciphertext: Buffer };
    expect(Buffer.from(raw.ciphertext).toString("latin1")).not.toContain("pinata-jwt");
  });
});
