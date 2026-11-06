import { expect, request, type APIRequestContext, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, PW, sessionToken } from "./harness";

export { PW };
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Cliente de la API local como lo usaría la web (Origin y token de sesión del arranque actual). */
export async function api(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: "http://127.0.0.1:4318", extraHTTPHeaders: { origin: "http://127.0.0.1:4317", "x-nebula-session": sessionToken() } });
}

export async function json<T = any>(ctx: APIRequestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, data?: unknown): Promise<T> {
  const r = await ctx.fetch(`/api${url}`, { method, ...(data !== undefined ? { data } : method !== "GET" ? { data: {} } : {}) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok()) throw new Error(`${method} ${url} → ${r.status()}: ${JSON.stringify(body)}`);
  return body as T;
}

/** Desbloquea desde la pantalla /unlock (si hace falta) y espera a salir de ella. */
export async function unlockUi(page: Page, path = "/") {
  // El estado real lo dice la API (la web redirige a /unlock en el cliente, tras leerlo)
  const locked = !(await json(await api(), "GET", "/vault/status")).unlocked;
  await page.goto(path);
  if (locked) {
    await page.waitForURL(/\/unlock/, { timeout: 30_000 });
    await page.getByPlaceholder("••••••••••••").fill(PW);
    await page.keyboard.press("Enter");
    await page.waitForURL((u) => !u.pathname.startsWith("/unlock"), { timeout: 30_000 });
  }
}

export async function unlockApi() {
  const a = await api();
  const st = await json(a, "GET", "/vault/status");
  if (!st.unlocked) await json(a, "POST", "/vault/unlock", { password: PW });
  return a;
}

/** Estado compartido entre escenarios (mint de prueba, ids) en la carpeta de datos de la suite. */
const SHARED = join(DATA_ROOT, "e2e-shared.json");
export const shared = {
  get: (): Record<string, any> => (existsSync(SHARED) ? JSON.parse(readFileSync(SHARED, "utf8")) : {}),
  set: (patch: Record<string, unknown>) => writeFileSync(SHARED, JSON.stringify({ ...shared.get(), ...patch })),
};

type W = { id: string; address: string; label: string; role: string | null; folderIds: string[] };

export async function makeWallets(a: APIRequestContext, prefix: string, count: number, extra: Record<string, unknown> = {}) {
  const r = await json<{ wallets: W[] }>(a, "POST", "/wallets", { count, labelPrefix: prefix, ...extra });
  return r.wallets.filter((w) => w.label.startsWith(prefix));
}

/** Lanza un token de prueba (Quick o Manual) contra Surfpool por la API y espera a que termine. */
export async function seedLaunch(a: APIRequestContext, opts: { symbol: string; dev: W; holders?: W[]; devBuySol?: number; holderSol?: number }) {
  const imageCid = (await json(a, "POST", "/launches/media", { fileB64: PNG, contentType: "image/png" })).cid;
  await json(a, "POST", "/launches/alt", { payerWalletId: opts.dev.id });
  const draftId = `e2e-${opts.symbol.toLowerCase()}-${Date.now()}`;
  const holders = opts.holders ?? [];
  const cfg = { draftId, name: `Prueba ${opts.symbol}`, symbol: opts.symbol, description: "Token de la suite E2E", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: opts.dev.id, devBuyLamports: String(Math.round((opts.devBuySol ?? 0.2) * 1e9)), mode: holders.length ? "quick" : "manual", holders: holders.map((h) => ({ walletId: h.id, lamports: String(Math.round((opts.holderSol ?? 0.1) * 1e9)) })), slippagePct: 25, mayhem: false, feeMode: "creator", feeAck: true };
  const pf = await json(a, "POST", "/launches/preflight", cfg);
  expect(pf.preflight.ok, JSON.stringify(pf.preflight)).toBe(true);
  await json(a, "POST", `/launches/${draftId}/execute`);
  for (let i = 0; i < 300; i++) {
    const v = await json(a, "GET", `/launches/${draftId}`);
    if (!["CREATING", "CREATED", "BUYING"].includes(v.status)) {
      expect(v.status).toBe("DONE");
      return { draftId, mint: v.mint as string, imageCid };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("El lanzamiento de prueba no terminó");
}
