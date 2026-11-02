import { expect, test, type Page } from "playwright/test";

const projectId = "9fe9e0e0-0b85-4eb8-bd69-7f16c7569f28";

async function installPrivatePreviewFixture(page: Page, options: { blockedThirdPartyCookie?: boolean } = {}) {
  const previewHost = `${projectId}.preview.example.test`;
  const previewOrigin = `https://${previewHost}`;
  const appOrigin = "http://127.0.0.1:4173";
  const state = {
    frameRequests: 0,
    sessionExchanges: 0,
    formBodies: [] as string[],
    formOrigins: [] as string[],
    cookieHeaders: [] as string[],
  };

  await page.context().routeWebSocket(`wss://${previewHost}/__vite_hmr`, (socket) => {
    socket.onMessage((message) => socket.send(message));
    socket.send("vite-hmr-ready");
  });

  await page.context().route(new RegExp(`^https://${previewHost.replace(/\./g, "\\.")}(?:/.*)?$`), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    state.cookieHeaders.push(request.headers().cookie ?? "");
    const corsHeaders = {
      "access-control-allow-origin": appOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      vary: "Origin",
      "cache-control": "private, no-store",
    };

    if (url.pathname === "/__session" && request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (url.pathname === "/__session" && request.method() === "POST") {
      const contentType = request.headers()["content-type"] ?? "";
      const body = request.postData() ?? "";
      if (contentType.includes("application/x-www-form-urlencoded")) {
        state.formBodies.push(body);
        state.formOrigins.push(request.headers().origin ?? "");
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: {
            "set-cookie": "__Host-preview_session=fixture-session-id; Path=/; Max-Age=900; Secure; HttpOnly; SameSite=None; Partitioned",
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
          },
          body: "<!doctype html><html><body>First-party preview fixture</body></html>",
        });
        return;
      }
      state.sessionExchanges += 1;
      const shortSession = new URLSearchParams(new URL(page.url()).search).has("short-session") && state.sessionExchanges === 1;
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: true, expiresAt: new Date(Date.now() + (shortSession ? 2_500 : 60_000)).toISOString() }),
      });
      return;
    }
    if (url.pathname === "/__session" && request.method() === "GET") {
      if (options.blockedThirdPartyCookie) {
        await route.fulfill({ status: 404, headers: { ...corsHeaders, "content-type": "application/json" }, body: "{\"error\":\"preview_unavailable\"}" });
      } else {
        await route.fulfill({ status: 204, headers: corsHeaders });
      }
      return;
    }
    if (url.pathname === "/assets/player.svg") {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 8 8\"><rect width=\"8\" height=\"8\" fill=\"#7aa2f7\"/></svg>",
      });
      return;
    }
    if (url.pathname === "/" && request.headers()["sec-fetch-dest"] === "document") {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
        body: "<!doctype html><html><body>First-party preview fixture</body></html>",
      });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/level/2") {
      state.frameRequests += 1;
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Phaser</title></head><body>
        <canvas id="game-canvas" width="320" height="200"></canvas><img id="player" src="/assets/player.svg" alt="player">
        <script>
          const canvas = document.querySelector('#game-canvas');
          canvas.getContext('2d').fillRect(4, 4, 20, 20);
          canvas.dataset.gameReady = 'true';
          document.querySelector('#player').addEventListener('load', () => { document.body.dataset.assetReady = 'true'; });
          window.parent.postMessage({ type: 'preview:route', path: location.pathname }, ${JSON.stringify(appOrigin)});
          const hot = new WebSocket('wss://${previewHost}/__vite_hmr');
          hot.addEventListener('open', () => { document.body.dataset.hmr = 'connected'; });
        </script>
      </body></html>`;
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "cache-control": "private, no-store" }, body: html });
      return;
    }
    await route.fulfill({ status: 404, body: "fixture not found" });
  });

  return { previewOrigin, state };
}

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

  test("envía el prompt, reconstruye progreso durable y conserva el transcript al recargar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Opciones rápidas" }).click();
    await page.getByRole("button", { name: "Insertar: RPG top-down" }).click();
    await page.getByRole("button", { name: "Cerrar" }).click();

    const prompt = page.getByLabel("Describe tu juego");
    await prompt.fill("Género: RPG top-down. Con un mapa y misiones.");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Enviar al agente" }).click();
    await expect(page.getByText("Género: RPG top-down. Con un mapa y misiones.", { exact: true })).toBeVisible();
    await expect(page.getByText("El prototipo quedó verificado.")).toBeVisible();

    await page.getByRole("tab", { name: /Plan/ }).click();
    await expect(page.getByText("Moverse hasta la meta.")).toBeVisible();
    await page.getByRole("tab", { name: /Archivos/ }).click();
    await expect(page.getByText("src/main.ts")).toBeVisible();
    await page.getByRole("tab", { name: /Verificación/ }).click();
    await expect(page.getByText("Build correcto.")).toBeVisible();

    await page.reload();
    await expect(page.getByText("Género: RPG top-down. Con un mapa y misiones.", { exact: true })).toBeVisible();
    await expect(page.getByText("El prototipo quedó verificado.")).toBeVisible();
    await page.getByRole("tab", { name: /Archivos/ }).click();
    await expect(page.getByText("src/main.ts")).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Share" })).toBeDisabled();
  });

  test("reconecta desde Last-Event-ID tras una caída del stream sin repetir progreso", async ({ page }) => {
    await page.goto("/?stream-drop=1");
    await page.getByLabel("Describe tu juego").fill("Crear un juego tras reconectar.");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Enviar al agente" }).click();
    await expect(page.getByText("El prototipo quedó verificado.")).toBeVisible();
    await expect.poll(() => page.evaluate((id) => {
      return JSON.parse(sessionStorage.getItem(`editor-e2e-stream-cursors-${id}`) ?? "[]") as number[];
    }, projectId)).toEqual([0, 3]);
    await page.getByRole("tab", { name: /Archivos/ }).click();
    await expect(page.getByText("src/main.ts")).toHaveCount(1);
  });

  test("permite detener un run activo y entrega su estado terminal", async ({ page }) => {
    await page.goto("/?run-active=1");
    await page.getByLabel("Describe tu juego").fill("Crear un puzzle corto.");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Enviar al agente" }).click();
    await page.getByRole("button", { name: "Detener" }).click();
    await expect(page.getByText("Cancelado", { exact: true })).toBeVisible();
    await expect(page.getByText("La ejecución se detuvo.")).toBeVisible();
  });

  test("una identidad distinta recibe 404 al suscribirse al run ajeno", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Describe tu juego").fill("Crear un juego de prueba.");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Enviar al agente" }).click();
    await expect(page.getByText("El prototipo quedó verificado.")).toBeVisible();
    const runId = await page.evaluate((id) => {
      const stored = JSON.parse(sessionStorage.getItem(`editor-e2e-run-${id}`) ?? "null") as { run?: { id?: string } } | null;
      return stored?.run?.id ?? "";
    }, projectId);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/i);
    await page.goto("/?identity=owner-b");
    const response = await page.evaluate(async (id) => {
      const result = await fetch(`/api/runs/${id}/events`, { headers: { accept: "text/event-stream" } });
      return { status: result.status, body: await result.text() };
    }, runId);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain("Moverse hasta la meta.");
  });

  test("canjea una sesión y monta un iframe aislado con canvas, assets y HMR", async ({ page }) => {
    const fixture = await installPrivatePreviewFixture(page);
    await page.context().addCookies([{ name: "clerk_session", value: "app-secret-cookie", url: "http://127.0.0.1:4173" }]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?preview=1&versions=1");

    const preview = page.getByRole("region", { name: "Vista previa privada del juego" });
    const frame = preview.locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(frame).toHaveAttribute("allow", "");
    await expect(frame).toHaveAttribute("src", `${fixture.previewOrigin}/`);
    expect(await frame.getAttribute("src")).not.toContain("grant=");
    const game = page.frameLocator("iframe");
    await expect(game.locator("canvas")).toHaveAttribute("data-game-ready", "true");
    await expect(game.locator("body")).toHaveAttribute("data-asset-ready", "true");
    await expect(game.locator("body")).toHaveAttribute("data-hmr", "connected");
    await expect(page.getByLabel("Estado de la preview: Lista")).toBeVisible();
    expect(fixture.state.cookieHeaders.every((cookie) => !cookie.includes("clerk_session"))).toBe(true);

    await page.getByRole("combobox", { name: "Versión de la vista previa" }).click();
    await expect(page.getByRole("option", { name: "Latest · última verificada" })).toBeVisible();
    const savedVersion = page.getByRole("option", { name: "v3 · verificada" });
    await expect(savedVersion).toBeEnabled();
    await savedVersion.click();
    await expect(page.getByRole("dialog")).toContainText("Snapshot verificado");
    await expect(page.getByRole("dialog")).toContainText("Build correcto");
    await page.getByRole("button", { name: "Cerrar" }).click();

    const reload = page.getByRole("button", { name: "Recargar vista previa" });
    await reload.focus();
    await expect(reload).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Volver en la vista previa" })).toBeDisabled();
    await expect.poll(() => fixture.state.frameRequests).toBe(2);
  });

  for (const identity of [
    { name: "anónimo", query: "anonymous", message: "Vuelve a iniciar sesión para abrir la preview." },
    { name: "otro dueño", query: "other-owner", message: "El proyecto ya no está disponible." },
  ]) {
    test(`no monta la preview para ${identity.name}`, async ({ page }) => {
      await page.goto(`/?preview=1&grant-error=${identity.query}`);
      const preview = page.getByRole("region", { name: "Vista previa privada del juego" });
      await expect(preview.getByText(identity.message).first()).toBeVisible();
      await expect(preview.locator("iframe")).toHaveCount(0);
      await expect(page.getByLabel("Estado de la preview: Error")).toBeVisible();
    });
  }

  test("rechaza un grant vencido antes de montar el iframe", async ({ page }) => {
    await page.goto("/?preview=1&expired-grant=1");
    const preview = page.getByRole("region", { name: "Vista previa privada del juego" });
    await expect(preview.getByText("El grant de preview ya venció.").first()).toBeVisible();
    await expect(preview.locator("iframe")).toHaveCount(0);
    await expect(page.getByLabel("Estado de la preview: Error")).toBeVisible();
  });

  test("atrás y adelante usan rutas confirmadas; mensajes falsificados no eligen destinos", async ({ page }) => {
    const fixture = await installPrivatePreviewFixture(page);
    await page.goto("/?preview=1");
    const appOrigin = await page.evaluate(() => location.origin);
    const back = page.getByRole("button", { name: "Volver en la vista previa" });
    const forward = page.getByRole("button", { name: "Avanzar en la vista previa" });
    await expect(page.getByLabel("Estado de la preview: Lista")).toBeVisible();

    await page.evaluate(() => window.postMessage({ type: "preview:route", path: "/forged-by-parent" }, location.origin));
    await page.frameLocator("iframe").locator("body").evaluate((_body, parentOrigin: string) => {
      window.parent.postMessage({ type: "preview:route", path: "https://attacker.example/" }, parentOrigin);
    }, appOrigin);
    await expect(back).toBeDisabled();

    await page.evaluate(() => {
      const frame = document.querySelector("iframe");
      const target = window as Window & { __previewMessages?: unknown[] };
      target.__previewMessages = [];
      window.addEventListener("message", (event: MessageEvent<unknown>) => {
        target.__previewMessages?.push({ origin: event.origin, sourceMatches: event.source === frame?.contentWindow, data: event.data });
      });
    });
    const senderInfo = await page.frameLocator("iframe").locator("body").evaluate((_body, parentOrigin: string) => {
      window.parent.postMessage({ type: "preview:route", path: "/level/2" }, parentOrigin);
      return { origin: location.origin, isTopLevel: window.parent === window, parentOrigin };
    }, appOrigin);
    expect(senderInfo).toMatchObject({ origin: fixture.previewOrigin, isTopLevel: false, parentOrigin: appOrigin });
    await page.waitForTimeout(100);
    const debugMessages = await page.evaluate(() => (window as Window & { __previewMessages?: unknown[] }).__previewMessages ?? []);
    expect(debugMessages).toContainEqual(expect.objectContaining({ origin: fixture.previewOrigin, sourceMatches: true, data: { type: "preview:route", path: "/level/2" } }));
    await expect(back).toBeEnabled();
    await expect(page.locator("iframe")).toHaveAttribute("src", `${fixture.previewOrigin}/`);
    await back.click();
    await expect(page.locator("iframe")).toHaveAttribute("src", `${fixture.previewOrigin}/`);
    await expect(forward).toBeEnabled();
    await forward.click();
    await expect(page.locator("iframe")).toHaveAttribute("src", `${fixture.previewOrigin}/level/2`);
    await expect.poll(() => fixture.state.frameRequests).toBeGreaterThanOrEqual(2);
  });

  test("expone expiración y permite renovar con un grant nuevo", async ({ page }) => {
    await installPrivatePreviewFixture(page);
    await page.goto("/?preview=1&short-session=1");
    await expect(page.getByLabel("Estado de la preview: Sesión vencida")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("La sesión expiró; renueva para continuar.")).toBeVisible();
    await page.getByRole("button", { name: "Recargar vista previa" }).click();
    await expect(page.getByLabel("Estado de la preview: Lista")).toBeVisible();
  });

  test("usa un formulario de primer nivel si se bloquea la cookie de terceros", async ({ page }) => {
    const fixture = await installPrivatePreviewFixture(page, { blockedThirdPartyCookie: true });
    await page.goto("/?preview=1");
    await expect(page.getByText(/El navegador bloqueó la cookie de terceros/).first()).toBeVisible();
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Abrir vista previa en otra pestaña" }).click();
    const popup = await popupPromise;
    await expect.poll(() => fixture.state.formBodies.length).toBe(1);
    expect(fixture.state.formOrigins).toEqual(["http://127.0.0.1:4173"]);
    await expect(popup).toHaveURL(`${fixture.previewOrigin}/__session`);
    await expect(popup.locator("body")).toHaveText("First-party preview fixture");
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    expect(await popup.context().cookies(fixture.previewOrigin)).toContainEqual(expect.objectContaining({ name: "__Host-preview_session" }));
    expect(fixture.state.formBodies[0]).toContain("grant=");
    expect(popup.url()).not.toContain("grant=");
  });
});
