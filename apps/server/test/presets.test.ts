// REQ-LAUNCH-018 / REQ-AUTO-009: presets de lanzamiento y de tareas.
import { describe, expect, it } from "vitest";
import { makeApp, PW } from "./helpers";

describe("REQ-LAUNCH-018 / REQ-AUTO-009 · presets", () => {
  it("guarda, lista, renombra y borra; nunca guarda la identidad del token, la confirmación de comisiones ni el mint", async () => {
    const { call, app } = await makeApp();
    expect((await call("GET", "/api/presets?kind=launch")).status).toBe(423); // bóveda sin abrir
    await call("POST", "/api/vault/setup", { password: PW, ack: true });
    const draft = { draftId: "d-123456789", name: "Mi token", symbol: "MIO", description: "x", image: { url: "data:..." }, links: { x: "https://x.com/a" }, feeAck: true, feeMode: "creator", launchMode: "pro", devBuy: "0,5", plan: ["w1", "w2"], delaysMs: { w2: "500" } };
    const p = await call("PUT", "/api/presets/preset-001", { kind: "launch", name: "Pro 2 SNIPE", data: draft });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.data).toEqual({ feeMode: "creator", launchMode: "pro", devBuy: "0,5", plan: ["w1", "w2"], delaysMs: { w2: "500" } });
    // nombre único por tipo (sin distinguir mayúsculas), pero se puede repetir entre tipos
    expect((await call("PUT", "/api/presets/preset-002", { kind: "launch", name: "pro 2 snipe", data: {} })).status).toBe(409);
    const t = await call("PUT", "/api/presets/preset-003", { kind: "task", name: "Pro 2 SNIPE", data: { type: "trailing", mint: "M".repeat(32), trailPct: 20 } });
    expect(t.status).toBe(200);
    expect(t.json.data).toEqual({ type: "trailing", trailPct: 20 });
    // actualizar el mismo id (renombrar) y listar por tipo
    expect((await call("PUT", "/api/presets/preset-001", { kind: "launch", name: "Pro rápido", data: { launchMode: "pro" } })).json.name).toBe("Pro rápido");
    expect((await call("PUT", "/api/presets/preset-001", { kind: "task", name: "x", data: {} })).status).toBe(409); // no cambia de tipo
    expect((await call("GET", "/api/presets?kind=launch")).json.items.map((x: { name: string }) => x.name)).toEqual(["Pro rápido"]);
    expect((await call("GET", "/api/presets?kind=task")).json.items).toHaveLength(1);
    expect((await call("PUT", "/api/presets/preset-004", { kind: "launch", name: "", data: {} })).status).toBe(400);
    expect((await call("DELETE", "/api/presets/preset-001")).status).toBe(200);
    expect((await call("GET", "/api/presets?kind=launch")).json.items).toHaveLength(0);
    expect((await call("DELETE", "/api/presets/preset-001")).status).toBe(404);
    await app.close();
  });
});
