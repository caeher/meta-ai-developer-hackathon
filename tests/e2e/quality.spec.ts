import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";

async function expectNoSeriousAccessibilityIssues(page: Page, view: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = result.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  expect(
    serious.map((violation) => ({
      rule: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
    })),
    `Serious accessibility findings on ${view}`,
  ).toEqual([]);
}

test("autenticación propia y dashboard conservan labels, foco y contraste", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sign-in");
  await expectNoSeriousAccessibilityIssues(page, "sign-in mobile");

  const email = page.getByLabel("Correo electrónico");
  for (let count = 0; count < 12 && !(await email.evaluate((element) => element === document.activeElement)); count += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(email).toBeFocused();
  const focus = await email.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
  });
  expect(focus.outlineStyle !== "none" || focus.outlineWidth !== "0px" || focus.boxShadow !== "none").toBe(true);

  await email.fill("jugador@example.test");
  await page.getByLabel("Contraseña").fill("contraseña-de-prueba");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Tus proyectos" })).toBeVisible();
  await expectNoSeriousAccessibilityIssues(page, "projects dashboard mobile");

  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoSeriousAccessibilityIssues(page, "projects dashboard desktop");
});

test("editor y estados de progreso no tienen fallos graves de accesibilidad", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectNoSeriousAccessibilityIssues(page, "editor mobile");
  await expect(page.getByRole("region", { name: "Chat y progreso" })).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("region", { name: "Vista previa privada del juego" })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Opciones rápidas" }).click();
  await expectNoSeriousAccessibilityIssues(page, "quick options dialog");
});
