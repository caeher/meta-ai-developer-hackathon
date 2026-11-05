import { chromium } from "playwright";

const OUTPUT_LIMIT = 8;
const checks = [];
const consoleErrors = [];
let blockedRequests = 0;

function check(name, passed, summary) {
  checks.push({ name, status: passed ? "passed" : "failed", summary: String(summary).slice(0, 500) });
}

function finish() {
  const passed = checks.length > 0 && checks.every((entry) => entry.status === "passed") && consoleErrors.length === 0 && blockedRequests === 0;
  const result = {
    status: passed ? "passed" : "failed",
    checks: checks.slice(0, 12),
    consoleErrors: consoleErrors.slice(0, OUTPUT_LIMIT).map((value) => String(value).slice(0, 500)),
    blockedRequests: Math.min(blockedRequests, 1000),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!passed) process.exitCode = 1;
}

async function main() {
  let input;
  try { input = JSON.parse(await readStdin()); }
  catch { check("verification input", false, "No se pudo validar la entrada de la prueba."); finish(); return; }
  const probe = input && typeof input === "object" && input.probe === true;
  const genre = input?.genre;
  const controls = input?.controls;
  if (!probe && (!(["platformer", "puzzle", "shooter", "rpg"].includes(genre)) ||
    !controls || !(["arrows", "wasd"].includes(controls.movement)) || !(["space", "e"].includes(controls.action)))) {
    check("verification input", false, "La especificación no es válida."); finish(); return;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process"] });
    if (probe) {
      check("isolated Chromium runtime", true, "Chromium aislado está instalado en la imagen del sandbox.");
      finish();
      return;
    }
    const context = await browser.newContext({ viewport: { width: 960, height: 600 }, serviceWorkers: "block", hasTouch: true });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const localPreview = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "4173";
      if (localPreview || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      blockedRequests += 1;
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => { if (consoleErrors.length < OUTPUT_LIMIT) consoleErrors.push(error.message); });
    page.on("console", (message) => {
      if (message.type() === "error" && consoleErrors.length < OUTPUT_LIMIT) consoleErrors.push(message.text());
    });
    page.on("requestfailed", () => { if (consoleErrors.length < OUTPUT_LIMIT) consoleErrors.push("Una solicitud local del juego falló."); });

    let navigationOk = false;
    try {
      const response = await page.goto(`http://127.0.0.1:4173/?genre=${encodeURIComponent(genre)}`, { waitUntil: "domcontentloaded", timeout: 8_000 });
      navigationOk = response?.ok() === true;
      await page.waitForFunction(() => window.__GAME_TEST__?.getState()?.assetsReady === true, undefined, { timeout: 8_000 });
      check("preview health", navigationOk, navigationOk ? "El navegador cargó la preview local y sus assets." : "La preview no respondió con HTTP exitoso.");
    } catch {
      check("preview health", false, "El navegador no pudo cargar la preview local y sus assets.");
    }

    const canvasVisible = await page.locator("#game canvas").isVisible().catch(() => false);
    check("canvas visible", canvasVisible, canvasVisible ? "El canvas del juego se muestra." : "No se encontró un canvas jugable visible.");
    const controlsVisible = await page.locator("#game-controls").isVisible().catch(() => false) &&
      await page.locator('#touch-controls button[data-control="right"]').isVisible().catch(() => false) &&
      await page.locator('#touch-controls button[data-control="action"]').isVisible().catch(() => false);
    check("controls visible", controlsVisible, controlsVisible ? "Se muestran controles de teclado y botones táctiles." : "Faltan controles accesibles visibles.");

    const genreMatches = await page.evaluate((expected) => window.__GAME_TEST__?.getState()?.genre === expected, genre).catch(() => false);
    check("selected game preset", genreMatches, genreMatches ? `El juego usa el preset ${genre}.` : "El runtime no cargó el género solicitado.");

    const beforeKeyboard = await page.evaluate(() => window.__GAME_TEST__?.getState()).catch(() => null);
    const rightKey = controls.movement === "wasd" ? "d" : "ArrowRight";
    await page.keyboard.down(rightKey).catch(() => undefined);
    await page.waitForTimeout(350);
    await page.keyboard.up(rightKey).catch(() => undefined);
    const keyboardMoved = await page.waitForFunction((before) => {
      const current = window.__GAME_TEST__?.getState();
      return Boolean(current && before && (current.x !== before.x || current.y !== before.y || current.moves > before.moves));
    }, beforeKeyboard, { timeout: 2_500 }).then(() => true).catch(() => false);
    check("keyboard interaction", keyboardMoved, keyboardMoved ? "El teclado cambia el estado del juego." : "El teclado no produjo movimiento del juego.");

    const beforeTouch = await page.evaluate(() => window.__GAME_TEST__?.getState()).catch(() => null);
    await page.evaluate(() => {
      window.__VERIFY_TOUCH_POINTER_TYPE__ = null;
      document.addEventListener("pointerdown", (event) => {
        window.__VERIFY_TOUCH_POINTER_TYPE__ = event.pointerType;
      }, { once: true });
    }).catch(() => undefined);
    const touchTarget = page.locator('#touch-controls button[data-control="right"]');
    const touchBox = await touchTarget.boundingBox().catch(() => null);
    let touchDispatched = touchBox !== null;
    let touchError = "";
    if (touchBox) {
      try {
        // Mantener el toque como se mantiene la tecla (350 ms): un tap
        // instantaneo puede no abarcar ningun frame del juego.
        const cdp = await page.context().newCDPSession(page);
        const touchX = touchBox.x + touchBox.width / 2;
        const touchY = touchBox.y + touchBox.height / 2;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY, id: 1 }] });
        await page.waitForTimeout(350);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await cdp.detach().catch(() => undefined);
      } catch (error) {
        touchDispatched = false;
        touchError = error instanceof Error ? error.message.slice(0, 240) : "touch_input_failed";
      }
    } else {
      touchError = "touch_control_not_visible";
    }
    const touchPointerType = await page.evaluate(() => window.__VERIFY_TOUCH_POINTER_TYPE__).catch(() => null);
    const touchMoved = touchDispatched && touchPointerType === "touch" && await page.waitForFunction((before) => {
      const current = window.__GAME_TEST__?.getState();
      return Boolean(current && before && (current.x !== before.x || current.y !== before.y || current.moves > before.moves));
    }, beforeTouch, { timeout: 2_500 }).then(() => true).catch(() => false);
    const touchSummary = touchMoved
      ? "Una pulsación táctil real mueve el juego."
      : !touchDispatched
        ? `Chromium no pudo pulsar el control táctil visible: ${touchError}`
        : touchPointerType !== "touch"
          ? "El control no recibió un evento pointerdown táctil."
          : "El control táctil no produjo movimiento del juego.";
    check("touch interaction", touchMoved, touchSummary);

    const loopReady = await page.evaluate(() => {
      const state = window.__GAME_TEST__?.getState();
      return Boolean(state && state.phase === "playing" && state.target > 0 && state.assetsReady);
    }).catch(() => false);
    check("playable loop", loopReady, loopReady ? "El juego inicia una partida con objetivo y assets listos." : "El juego no inició un loop con objetivo verificable.");
    check("browser network isolation", blockedRequests === 0, blockedRequests === 0 ? "El navegador no intentó salir de la preview aislada." : "Se bloquearon solicitudes fuera del origen de preview.");
    await context.close();
  } catch (error) {
    check("isolated Chromium runtime", false, error instanceof Error ? error.message : "No se pudo iniciar Chromium.");
  } finally {
    await browser?.close().catch(() => undefined);
  }
  finish();
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; if (value.length > 8_192) reject(new Error("input_too_large")); });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

await main().catch((error) => {
  check("isolated Chromium runtime", false, error instanceof Error ? error.message : "Error de navegador.");
  finish();
});
