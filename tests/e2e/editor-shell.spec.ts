import { expect, test } from "playwright/test";

test.describe("editor de dos paneles", () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    test(`se adapta a ${viewport.width}px sin desbordar la página`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");

      const dimensions = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        viewportHeight: window.innerHeight,
        pageHeight: document.documentElement.scrollHeight,
      }));
      expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
      expect(dimensions.pageHeight).toBeLessThanOrEqual(dimensions.viewportHeight + 1);
      await expect(page.getByRole("region", { name: "Chat y progreso" })).toBeVisible();
      const preview = page.getByRole("region", { name: "Vista previa privada del juego" });
      if (viewport.width <= 640) {
        await expect(preview).toBeHidden();
        await page.getByRole("button", { name: "Preview" }).click();
      }
      await expect(preview).toBeVisible();
      const chatScrollMode = await page.locator("ol[aria-label='Transcripción privada en orden de envío']").evaluate((element) => getComputedStyle(element).overflowY);
      const previewScrollMode = await preview.evaluate((element) => getComputedStyle(element).overflowY);
      expect(chatScrollMode).toBe("auto");
      expect(previewScrollMode).toBe("auto");
      await expect(preview.locator("iframe")).toHaveCount(0);
    });
  }

  test("inserta una opción, permite editarla, guarda y conserva el transcript al recargar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Opciones rápidas" }).click();
    await page.getByRole("button", { name: "Insertar: RPG top-down" }).click();
    await page.getByRole("button", { name: "Cerrar" }).click();

    const prompt = page.getByLabel("Describe tu juego");
    await prompt.fill("Género: RPG top-down. Con un mapa y misiones.");
    await page.getByRole("button", { name: "Guardar mensaje" }).click();
    await expect(page.getByText("Género: RPG top-down. Con un mapa y misiones.", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("El agente todavía no ejecuta generación.");

    await page.reload();
    await expect(page.getByText("Género: RPG top-down. Con un mapa y misiones.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Share" })).toBeDisabled();
  });
});
