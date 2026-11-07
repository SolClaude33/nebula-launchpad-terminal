// E2E-06 IPFS fallido bloquea el lanzamiento · E2E-08 borrador y reanudación tras reiniciar la app ·
// E2E-09 lanzamiento programado tras un reinicio (y cancelar otro)
import { expect, test, type Page } from "@playwright/test";
import { restartApi } from "./harness";
import { json, makeWallets, PNG, shared, unlockApi, unlockUi } from "./helpers";

test.describe.configure({ mode: "serial" });

const PNG_FILE = { name: "logo.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") };

async function step(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Pasos del lanzamiento" }).getByRole("button", { name: new RegExp(name) }).click();
}

test.beforeAll(async () => {
  const a = await unlockApi();
  const [dev] = await makeWallets(a, "DevL", 1, { role: "dev" });
  await json(a, "POST", "/dev/airdrop", { walletIds: [dev.id], sol: 5 });
  await json(a, "POST", "/launches/alt", { payerWalletId: dev.id });
  shared.set({ devL: dev });
});

test("E2E-06 · si la subida a IPFS falla, «Lanzar» está deshabilitado con el motivo; volver a subir lo habilita", async ({ page }) => {
  await unlockUi(page, "/launch/new?new=1");
  await page.locator("#name").fill("Ipfs Roto");
  await page.locator("#symbol").fill("IPFS");
  // fallo forzado de la subida (la API local responde 502 como si Pinata hubiera caído)
  await page.route("**/api/launches/media", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ code: "IPFS_UNAVAILABLE", message: "Pinata no responde (fallo simulado)" }) }));
  await page.locator('input[type="file"]').setInputFiles(PNG_FILE);
  await expect(page.getByText(/fallo simulado/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Volver a subir/ })).toBeVisible();
  // el resumen lista el motivo y el botón está deshabilitado
  await expect(page.getByText("La subida falló. Vuelve a subir.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lanzar", exact: true })).toBeDisabled();
  await page.unroute("**/api/launches/media");
  await page.getByRole("button", { name: /Volver a subir/ }).click();
  await expect(page.getByText("La subida falló. Vuelve a subir.")).toBeHidden();
  await expect(page.getByText(/Subida/).first()).toBeVisible();
});

test("E2E-08 · rellenar a medias, cerrar con Esc, reiniciar la app y reanudar desde Borradores sin perder nada", async ({ page }) => {
  await unlockUi(page, "/launch/new?new=1");
  await page.locator("#name").fill("Medio Hecho");
  await page.locator("#symbol").fill("HALF");
  await page.locator("#description").fill("Borrador que sobrevive a un reinicio");
  await page.locator("#x").fill("https://x.com/medio_hecho");
  await expect(page.getByText("Guardado", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.waitForURL(/\/launches\/drafts/);
  await expect(page.getByText("Medio Hecho")).toBeVisible();

  await restartApi(); // cerrar y abrir la app: la bóveda vuelve a estar bloqueada
  await unlockUi(page, "/launches/drafts");
  const card = page.getByRole("listitem").filter({ hasText: "Medio Hecho" });
  await card.getByRole("button", { name: "Continuar" }).click();
  await page.waitForURL(/\/launch\/new\?draft=/);
  await expect(page.locator("#name")).toHaveValue("Medio Hecho");
  await expect(page.locator("#symbol")).toHaveValue("HALF");
  await expect(page.locator("#description")).toHaveValue("Borrador que sobrevive a un reinicio");
  await expect(page.locator("#x")).toHaveValue("https://x.com/medio_hecho");
});

test("E2E-09 · programado a su hora: se cierra y abre la app, se desbloquea y se lanza; otro se cancela", async ({ page }) => {
  test.setTimeout(420_000);
  const dev = shared.get().devL;
  await unlockUi(page, "/launch/new?new=1");
  await page.locator("#name").fill("Reloj Programado");
  await page.locator("#symbol").fill("CLOCK");
  await page.locator('input[type="file"]').setInputFiles(PNG_FILE);
  await expect(page.getByText(/Subida/).first()).toBeVisible();
  await step(page, "Configuración");
  await page.locator("#devWallet").selectOption(dev.id);
  await page.locator("#devBuy").fill("0,05");
  await page.getByRole("radio", { name: /Manual/ }).check({ force: true }); // el input es sr-only dentro de la tarjeta
  await page.locator("#feeAck input[type=checkbox]").check();
  await step(page, "Revisar y lanzar");
  await page.getByRole("button", { name: "Simular" }).click();
  await expect(page.getByText("Todo en verde. Ya puedes lanzar.")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Programar para más tarde" }).click();
  // la hora del campo es de minutos: el siguiente minuto con al menos 40 s de margen
  const at = new Date(Math.ceil((Date.now() + 40_000) / 60_000) * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  await page.locator("#launch-at").fill(`${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`);
  await page.getByRole("button", { name: "Programar", exact: true }).click();
  await expect(page.getByText("Programado", { exact: true })).toBeVisible();

  // un segundo programado, por la API, que se cancela desde Lanzamientos > asistente
  const a = await unlockApi();
  const imageCid = (await json(a, "POST", "/launches/media", { fileB64: PNG, contentType: "image/png" })).cid;
  const other = `e2e-cancel-${Date.now()}`;
  await json(a, "PUT", `/drafts/${other}`, { draftId: other, name: "Cancelado", symbol: "NOPE" });
  await json(a, "POST", "/launches/preflight", { draftId: other, name: "Cancelado", symbol: "NOPE", description: "", imageCid, links: { x: "", telegram: "", web: "" }, devWalletId: dev.id, devBuyLamports: "50000000", mode: "manual", holders: [], slippagePct: 15, mayhem: false, feeMode: "creator", feeAck: true });
  await json(a, "POST", `/launches/${other}/schedule`, { at: Date.now() + 10 * 60_000 });

  await restartApi(); // reinicio antes de la hora
  await unlockUi(page, "/launches");
  await expect(page.getByRole("listitem").filter({ hasText: "$CLOCK" }).getByText("Programado", { exact: true })).toBeVisible();
  // cancelar el otro desde su borrador en el asistente
  await page.goto(`/launch/new?draft=${other}`);
  await step(page, "Revisar y lanzar");
  await page.getByRole("button", { name: "Cancelar la programación" }).click();
  await expect(page.getByRole("button", { name: "Programar para más tarde" })).toBeVisible();
  // a su hora se lanza solo (sin tocar nada)
  await page.goto("/launches");
  await expect(page.getByRole("listitem").filter({ hasText: "$CLOCK" }).getByText("Lanzado", { exact: true })).toBeVisible({ timeout: Math.max(60_000, at.getTime() - Date.now() + 120_000) });
  await expect(page.getByRole("listitem").filter({ hasText: "$NOPE" })).toHaveCount(0);
  const drafts = (await json(await unlockApi(), "GET", "/drafts")).items.map((d: { id: string }) => d.id);
  expect(drafts).toContain(other);
});
