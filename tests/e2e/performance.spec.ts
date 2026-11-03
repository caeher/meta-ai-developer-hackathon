import { expect, test } from "playwright/test";

const projectId = "9fe9e0e0-0b85-4eb8-bd69-7f16c7569f28";
const previewHost = `${projectId}.preview.example.test`;

test.skip(({ browserName }) => browserName !== "chromium", "Los presupuestos comparables se miden en Chromium headless.");

test("shell, primer evento, arranque/recarga de preview y FPS cumplen sus presupuestos", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const shellStartedAt = Date.now();
  await page.goto("/");
  await page.getByRole("button", { name: "Opciones rápidas" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Opciones rápidas" })).toBeVisible();
  const shellInteractiveMs = Date.now() - shellStartedAt;
  await page.getByRole("button", { name: "Cerrar" }).click();

  await page.getByLabel("Describe tu juego").fill("Crear un prototipo breve para medir la primera respuesta.");
  await page.getByRole("checkbox").check();
  const firstEventStart = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "Enviar al agente" }).click();
  await expect(page.getByText("Planificando", { exact: true })).toBeVisible();
  const firstEventMs = await page.evaluate((startedAt) => performance.now() - startedAt, firstEventStart);
  await expect(page.getByText("El prototipo quedó verificado.")).toBeVisible();

  let frameRequests = 0;
  await page.context().route(new RegExp(`^https://${previewHost.replace(/\./g, "\\\.")}(?:/.*)?$`), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const corsHeaders = {
      "access-control-allow-origin": "http://127.0.0.1:4173",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "private, no-store",
      vary: "Origin",
    };
    if (url.pathname === "/__session" && request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (url.pathname === "/__session" && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, "content-type": "application/json" },
        body: JSON.stringify({ ok: true, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      });
      return;
    }
    if (url.pathname === "/__session" && request.method() === "GET") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (url.pathname === "/") frameRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "cache-control": "private, no-store" },
      body: `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Juego fixture</title></head><body>
        <canvas id="game-canvas" width="320" height="200" aria-label="Juego de prueba"></canvas>
        <script>
          const canvas = document.querySelector('#game-canvas');
          canvas.getContext('2d').fillRect(4, 4, 20, 20);
          canvas.dataset.gameReady = 'true';
          canvas.dataset.frameCount = "0";
          const tick = () => {
            canvas.dataset.frameCount = String(Number(canvas.dataset.frameCount) + 1);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        </script>
      </body></html>`,
    });
  });

  const previewStartedAt = Date.now();
  await page.goto("/?preview=1");
  await expect(page.getByLabel("Estado de la preview: Lista")).toBeVisible();
  const game = page.frameLocator("iframe");
  await expect(game.locator("canvas")).toHaveAttribute("data-game-ready", "true");
  const previewBootMs = Date.now() - previewStartedAt;

  const initialFrameRequests = frameRequests;
  const refreshStartedAt = Date.now();
  await page.getByRole("button", { name: "Recargar vista previa" }).click();
  await expect.poll(() => frameRequests).toBeGreaterThan(initialFrameRequests);
  await expect(page.getByLabel("Estado de la preview: Lista")).toBeVisible();
  await expect(page.frameLocator("iframe").locator("canvas")).toHaveAttribute("data-game-ready", "true");
  const previewRefreshMs = Date.now() - refreshStartedAt;

  const gameCanvas = page.frameLocator("iframe").locator("canvas");
  const beforeFrames = Number(await gameCanvas.getAttribute("data-frame-count"));
  const fpsStartedAt = Date.now();
  await page.waitForTimeout(1_000);
  const afterFrames = Number(await gameCanvas.getAttribute("data-frame-count"));
  const fpsSample = Math.round(((afterFrames - beforeFrames) * 1_000) / (Date.now() - fpsStartedAt));

  const measurements = { shellInteractiveMs, firstEventMs: Math.round(firstEventMs), previewBootMs, previewRefreshMs, gameFps: fpsSample };
  console.log(`PERFORMANCE_BASELINE ${JSON.stringify(measurements)}`);
  expect(shellInteractiveMs, "interactive shell budget").toBeLessThanOrEqual(2_500);
  expect(firstEventMs, "first visible SSE event budget").toBeLessThanOrEqual(1_000);
  expect(previewBootMs, "preview boot budget").toBeLessThanOrEqual(3_000);
  expect(previewRefreshMs, "preview refresh budget").toBeLessThanOrEqual(2_500);
  expect(fpsSample, "fixture game FPS floor").toBeGreaterThanOrEqual(30);
});
