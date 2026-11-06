// E2E-03 crear y organizar wallets · E2E-17 exportar una clave con reconfirmación, registro y logs limpios
import { expect, test } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./harness";
import { api, json, PW, unlockUi } from "./helpers";

test.describe.configure({ mode: "serial" });

test("E2E-03 · crear 10 wallets en una carpeta, rol Holder, filtrar y copiar direcciones", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4317" });
  await unlockUi(page, "/wallets");
  // carpeta nueva
  await page.getByRole("button", { name: "Nueva carpeta" }).click();
  await page.getByLabel("Nombre de la carpeta").fill("Lote E2E");
  await page.getByLabel("Nombre de la carpeta").blur();
  await expect(page.getByRole("navigation", { name: "Carpetas" }).getByText("Lote E2E")).toBeVisible();
  // 10 wallets dentro de la carpeta
  await page.getByRole("button", { name: "Crear", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Crear wallets" });
  await dlg.getByRole("textbox").first().fill("10");
  await dlg.getByPlaceholder("Wallet").fill("Lote");
  await dlg.locator("select").nth(1).selectOption({ label: "Lote E2E" });
  await dlg.getByRole("button", { name: "Crear 10" }).click();
  await expect(dlg).toBeHidden();
  // filtrar por la carpeta, seleccionar todas y asignar el rol holder
  await page.getByRole("navigation", { name: "Carpetas" }).getByText("Lote E2E").click();
  await expect(page.getByText(/10 visibles/)).toBeVisible();
  await page.getByLabel("Seleccionar todas las visibles").check();
  await expect(page.getByText(/10 seleccionadas/)).toBeVisible();
  await page.getByRole("button", { name: "Rol" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "holder", exact: true }).click();
  // filtro por rol en «Todas»
  await page.getByRole("navigation", { name: "Carpetas" }).getByText("Todas").click();
  await page.getByLabel("Filtrar por rol").selectOption("holder");
  await expect(page.getByText(/10 visibles/)).toBeVisible();
  await page.getByLabel("Seleccionar todas las visibles").uncheck().catch(() => {});
  await page.getByRole("button", { name: /Copiar (todas|selección)/ }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const lines = clip.split(/\r?\n/).filter(Boolean); // el portapapeles de Windows devuelve \r\n
  expect(lines).toHaveLength(10);
  const a = await api();
  const ws = (await json(a, "GET", "/wallets")).wallets as { address: string; role: string | null; label: string; folderIds: string[] }[];
  const lote = ws.filter((w) => w.label.startsWith("Lote"));
  expect(lote).toHaveLength(10);
  expect(lote.every((w) => w.role === "holder" && w.folderIds.length === 1)).toBe(true);
  expect(new Set(lines)).toEqual(new Set(lote.map((w) => w.address)));
});

test("E2E-17 · exportar una clave pide la contraseña, queda en la actividad y no aparece en ningún log", async ({ page }) => {
  await unlockUi(page, "/wallets");
  await page.getByLabel("Filtrar por rol").selectOption("holder");
  // seleccionar la primera wallet de la tabla
  await page.getByRole("row").first().getByRole("checkbox").check();
  await page.getByRole("button", { name: "Exportar" }).click();
  const step = page.getByRole("dialog");
  await step.locator("#stepup-pw").fill("no-es-la-contraseña");
  await step.getByRole("button", { name: "Confirmar" }).click();
  await expect(step.getByText("Contraseña incorrecta.")).toBeVisible();
  await page.waitForTimeout(2_300); // retardo creciente tras el fallo
  await step.locator("#stepup-pw").fill(PW);
  await step.getByRole("button", { name: "Confirmar" }).click();
  // la clave se muestra con temporizador
  const reveal = page.getByRole("dialog");
  await reveal.getByRole("button", { name: "Mostrar claves" }).click();
  const key = (await reveal.locator("code").first().textContent())?.trim() ?? "";
  expect(key).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  await reveal.getByRole("button", { name: "Cerrar y olvidar" }).click();
  // registro de actividad
  await page.goto("/activity");
  await expect(page.getByText(/Exportadas 1 claves/).first()).toBeVisible();
  // escaneo de logs: la clave no aparece
  for (const f of readdirSync(join(DATA_DIR, "logs"))) expect(readFileSync(join(DATA_DIR, "logs", f), "utf8")).not.toContain(key);
});
