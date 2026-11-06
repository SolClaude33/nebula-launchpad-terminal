// E2E-11 Instant Trade con atajos (órdenes reales contra Surfpool) · E2E-23 el Dashboard muestra el P&L de la API
import { expect, test } from "@playwright/test";
import { json, makeWallets, seedLaunch, shared, unlockApi, unlockUi } from "./helpers";

test.describe.configure({ mode: "serial" });

const tradeCount = async () => ((await json(await unlockApi(), "GET", "/activity?kind=trade&limit=200")).items as { kind: string }[]).filter((x) => x.kind === "trade.buy").length;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  const a = await unlockApi();
  await json(a, "POST", "/folders", { name: "Instant E2E" });
  const folder = ((await json(a, "GET", "/folders")).folders as { id: string; name: string }[]).find((f) => f.name === "Instant E2E")!;
  const [dev] = await makeWallets(a, "DevLive", 1, { role: "dev" });
  const holders = await makeWallets(a, "Rápida", 2, { role: "trading", folderId: folder.id });
  await json(a, "POST", "/dev/airdrop", { walletIds: [dev.id], sol: 3 });
  await json(a, "POST", "/dev/airdrop", { walletIds: holders.map((h) => h.id), sol: 2 });
  const { mint } = await seedLaunch(a, { symbol: "LIVE", dev, holders, devBuySol: 0.3, holderSol: 0.1 });
  shared.set({ liveMint: mint, liveFolder: folder.id, liveHolders: holders.map((h) => h.id) });
});

test("E2E-11 · sin Espacio ninguna tecla compra; con Espacio + Q compra el monto rápido desde la carpeta y el P&L se actualiza", async ({ page }) => {
  const { liveMint, liveFolder, liveHolders } = shared.get();
  await unlockUi(page, `/t/${liveMint}`);
  const panel = page.getByRole("region", { name: "Instant Trade" });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await panel.getByLabel("Carpeta del Instant Trade").selectOption(liveFolder);
  await expect(panel.getByText("seguro")).toBeVisible();
  await page.locator("main").click({ position: { x: 5, y: 5 } }); // foco fuera de cualquier campo
  const before = await tradeCount();
  const balances = async () => {
    const a = await unlockApi();
    const pos = await json(a, "GET", `/live/${liveMint}/position`);
    return Object.fromEntries((pos.items as { walletId: string; tokens: string }[]).filter((i) => liveHolders.includes(i.walletId)).map((i) => [i.walletId, BigInt(i.tokens)]));
  };
  const b0 = await balances();

  // Q sin Espacio: nada
  await page.keyboard.press("q");
  await page.waitForTimeout(2_500);
  expect(await tradeCount()).toBe(before);

  // Espacio armado + Q = compra de 0,05 SOL por wallet de la carpeta
  await page.keyboard.down("Space");
  await expect(panel.getByText("armado")).toBeVisible();
  await page.keyboard.press("q");
  await page.keyboard.up("Space");
  await expect(panel.getByText("seguro")).toBeVisible();
  await expect.poll(tradeCount, { timeout: 90_000 }).toBe(before + 1);
  await expect.poll(async () => {
    const b1 = await balances();
    return liveHolders.every((id: string) => b1[id] > b0[id]);
  }, { timeout: 90_000 }).toBe(true);
  // el P&L de la selección refleja la nueva posición (deja de ser un guion)
  await expect(panel.getByText(/SOL/).first()).toBeVisible();
  // la orden fue del Instant Trade y por 0,05 SOL
  const last = ((await json(await unlockApi(), "GET", "/activity?kind=trade&limit=5")).items as { kind: string; detail: string }[]).find((x) => x.kind === "trade.buy")!;
  expect(last.detail).toMatch(/Instant Trade|instant/i);
  expect(last.detail).toContain("0.05 SOL por wallet");
});

test("E2E-23 · el Dashboard enseña los mismos trades y P&L que calcula la API", async ({ page }) => {
  const a = await unlockApi();
  const d = await json(a, "GET", `/dashboard?period=all&tz=${new Date().getTimezoneOffset()}`);
  expect(d.totals.trades).toBeGreaterThan(0);
  await unlockUi(page, "/");
  await page.getByRole("tab", { name: "Todo" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const row = page.getByText("Trades propios").locator("..");
  await expect(row).toContainText(String(d.totals.trades));
  const sol = (d.totals.pnlLamports / 1e9).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(d.totals.pnlLamports / 1e9) >= 100 ? 2 : 4 });
  await expect(page.getByText("P&L del período").locator("..")).toContainText(sol);
  await expect(page.getByRole("region", { name: "Mejores lanzamientos" })).toContainText("$LIVE");
});
