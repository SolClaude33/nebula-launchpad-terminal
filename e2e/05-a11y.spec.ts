// E2E-24 accesibilidad: axe sin violaciones serias ni críticas en las rutas principales, a 1024 y 1440 px,
// y sin scroll horizontal (§8.5).
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT } from "./harness";
import { shared, unlockUi } from "./helpers";

const ROUTES = ["/", "/wallets", "/funder", "/launches", "/launches/drafts", "/launch/new", "/t/LIVE", "/automations", "/rewards", "/activity", "/settings"];
const SIZES = [
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

test.describe.configure({ mode: "serial" });

for (const size of SIZES) {
  test(`E2E-24 · axe y scroll horizontal a ${size.width} px`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize(size);
    const mint = shared.get().liveMint as string | undefined;
    await unlockUi(page, "/");
    const report: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const r of ROUTES) {
      const path = r === "/t/LIVE" ? (mint ? `/t/${mint}` : "/t") : r;
      await page.goto(path);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1_500); // datos en vivo y animaciones de entrada
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const serious = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      report[path.startsWith("/t/") ? "/t/[mint]" : path] = { serious: serious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) })), minor: res.violations.filter((v) => !serious.includes(v)).map((v) => v.id), overflow };
      for (const v of serious) problems.push(`${path} · ${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      if (overflow > 0) problems.push(`${path} · scroll horizontal de ${overflow} px`);
    }
    // también la pantalla de desbloqueo (bóveda bloqueada) y el primer arranque no aplica (ya hay bóveda)
    await page.getByRole("button", { name: /Bloquear ahora/ }).click();
    await page.waitForURL(/\/unlock/);
    await page.waitForTimeout(1_000);
    const un = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const unSerious = un.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    report["/unlock"] = { serious: unSerious.map((v) => v.id), overflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) };
    for (const v of unSerious) problems.push(`/unlock · ${v.id} (${v.impact})`);
    writeFileSync(join(DATA_ROOT, `axe-${size.width}.json`), JSON.stringify(report, null, 2));
    await unlockUi(page, "/");
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
