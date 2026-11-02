import { expect, test } from "playwright/test";
import type { GameGenre, GameSnapshot } from "../../packages/game-templates/phaser/src/game/types";

const genres: readonly GameGenre[] = ["platformer", "puzzle", "shooter", "rpg"];

test("all genre presets load local assets, accept controls, and restart without duplicate state", async ({ page, baseURL }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const externalRequests: string[] = [];
  const hmrSockets: string[] = [];
  page.on("websocket", (socket) => hmrSockets.push(socket.url()));
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? "failed"})`));
  page.on("request", (request) => {
    const requested = new URL(request.url());
    const expected = new URL(baseURL!);
    const sameOrigin = requested.origin === expected.origin;
    const localSocket = requested.hostname === expected.hostname && requested.port === expected.port && requested.protocol === "ws:";
    if (!sameOrigin && !localSocket) {
      externalRequests.push(request.url());
    }
  });

  for (const genre of genres) {
    await page.goto(`/?genre=${genre}`);
    await page.waitForFunction(() => window.__GAME_TEST__?.getState()?.assetsReady === true);
    const canvas = page.locator("#game canvas");
    await expect(canvas).toBeVisible();
    expect(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).toEqual([960, 540]);

    const initial = await readState(page);
    expect(initial).toMatchObject({ genre, phase: "playing", lives: 3, score: 0 });
    await expect(page.getByRole("button", { name: "Reiniciar juego" })).toBeVisible();

    if (genre === "platformer" || genre === "shooter") {
      await page.keyboard.down("ArrowRight");
      await page.waitForTimeout(180);
      await page.keyboard.up("ArrowRight");
      await expect.poll(async () => (await readState(page)).x).toBeGreaterThan(initial.x);
    } else {
      await page.keyboard.press("ArrowRight");
      await expect.poll(async () => (await readState(page)).x).toBe(initial.x + 1);
      await page.keyboard.press("ArrowLeft");
      await page.getByRole("button", { name: "Mover derecha" }).click();
      await expect.poll(async () => (await readState(page)).x).toBe(initial.x + 1);
      await page.getByRole("button", { name: "Mover izquierda" }).click();
    }

    const beforeAction = await readState(page);
    await page.getByRole("button", {
      name: genre === "platformer" ? "Saltar" : genre === "shooter" ? "Disparar" : genre === "rpg" ? "Usar" : "Interactuar",
      exact: true,
    }).click();
    await expect.poll(async () => (await readState(page)).actions).toBe(beforeAction.actions + 1);
    if (genre === "platformer") await expect.poll(async () => (await readState(page)).velocityY).toBeLessThan(0);
    await page.getByRole("button", { name: "Silenciar o activar sonido" }).click();
    await expect.poll(async () => (await readState(page)).muted).toBe(true);
    await page.getByRole("button", { name: "Pausar juego" }).click();
    await expect.poll(async () => (await readState(page)).paused).toBe(true);
    await page.getByRole("button", { name: "Continuar juego" }).click();
    await expect.poll(async () => (await readState(page)).paused).toBe(false);
    await page.getByRole("button", { name: "Reiniciar juego" }).click();
    await expect.poll(async () => readState(page)).toMatchObject({ genre, phase: "playing", lives: 3, score: 0, moves: 0, actions: 0 });
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(hmrSockets.length).toBeGreaterThan(0);
  for (const url of hmrSockets) {
    const socket = new URL(url);
    expect(socket.protocol).toBe("ws:");
    expect(socket.hostname).toBe("127.0.0.1");
    expect(socket.port).toBe("4174");
  }
});

test("Phaser loads generated assets from its validated manifest into the game cache", async ({ page }) => {
  const assetId = "00000000-0000-4000-8000-000000000201";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64");
  const requested: string[] = [];
  await page.route("**/assets/generated/manifest.json", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ schemaVersion: 1, assets: [{
      assetId,
      key: `generated-${assetId}`,
      path: `assets/generated/${assetId}.png`,
      assetType: "sprite",
      frameColumns: 1,
      frameRows: 1,
      frameWidth: 1,
      frameHeight: 1,
    }] }),
  }));
  await page.route(`**/assets/generated/${assetId}.png`, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ contentType: "image/png", body: png });
  });
  await page.goto("/?genre=platformer");
  await page.waitForFunction(() => window.__GAME_TEST__?.getState()?.assetsReady === true);

  const snapshot = await readState(page);
  expect(snapshot.generatedAssetKeys).toEqual([`generated-${assetId}`]);
  expect(requested).toHaveLength(1);
});

test("puzzle can be won and lost with keyboard play, then restarted", async ({ page }) => {
  await page.goto("/?genre=puzzle");
  await page.waitForFunction(() => window.__GAME_TEST__?.getState()?.assetsReady === true);

  for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown", "ArrowRight", "ArrowDown", "ArrowRight", "ArrowRight", "ArrowDown"]) {
    await page.keyboard.press(key);
  }
  await expect.poll(async () => (await readState(page)).phase).toBe("won");

  await page.keyboard.press("r");
  await expect.poll(async () => (await readState(page)).phase).toBe("playing");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await readState(page)).x).toBe(2);
  await page.keyboard.press("r");
  await expect.poll(async () => (await readState(page)).x).toBe(1);
  for (let life = 0; life < 3; life += 1) {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
  }
  await expect.poll(async () => (await readState(page)).phase).toBe("lost");
  await page.keyboard.press("r");
  await expect.poll(async () => readState(page)).toMatchObject({ phase: "playing", lives: 3, score: 0 });
});

test("shooter projectiles hit enemies and complete the objective", async ({ page }) => {
  await page.goto("/?genre=shooter");
  await page.waitForFunction(() => window.__GAME_TEST__?.getState()?.assetsReady === true);
  for (let shot = 0; shot < 5; shot += 1) {
    await page.keyboard.press("Space");
    await expect.poll(async () => (await readState(page)).actions, { timeout: 2_000 }).toBe(shot + 1);
    await expect.poll(async () => {
      const state = await readState(page);
      return state.projectilesActive > 0 || state.score === shot + 1;
    }, { timeout: 2_000 }).toBe(true);
    await expect.poll(async () => readState(page), { timeout: 3_000 }).toMatchObject({ score: shot + 1, targetsRemaining: 4 - shot });
  }
  await expect.poll(async () => (await readState(page)).phase).toBe("won");
  await page.keyboard.press("r");
  await expect.poll(async () => readState(page)).toMatchObject({ phase: "playing", lives: 3, score: 0 });
});

test("RPG preset can collect the runes and reach its gate", async ({ page }) => {
  await page.goto("/?genre=rpg");
  await page.waitForFunction(() => window.__GAME_TEST__?.getState()?.assetsReady === true);
  for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown", "ArrowRight", "ArrowDown", "ArrowRight", "ArrowRight", "ArrowDown"]) {
    await page.keyboard.press(key);
  }
  await expect.poll(async () => (await readState(page)).phase).toBe("won");
});

test("platformer preset jumps across the guardian and completes the level", async ({ page }) => {
  await page.goto("/?genre=platformer");
  await page.waitForFunction(() => window.__GAME_TEST__?.getState()?.assetsReady === true);
  await expect.poll(async () => (await readState(page)).y, { timeout: 3_000 }).toBeGreaterThan(480);
  await page.keyboard.down("Space");
  await expect.poll(async () => (await readState(page)).velocityY, { timeout: 1_000 }).toBeLessThan(0);
  await page.keyboard.press("r");
  await page.keyboard.up("Space");
  await expect.poll(async () => readState(page)).toMatchObject({ phase: "playing", lives: 3, score: 0, actions: 0 });
  await page.keyboard.down("ArrowRight");
  await page.waitForFunction(() => (window.__GAME_TEST__?.getState()?.x ?? 0) > 420, { timeout: 5_000 });
  await page.keyboard.press("Space");
  await page.waitForFunction(() => (window.__GAME_TEST__?.getState()?.velocityY ?? 0) < 0, { timeout: 1_000 });
  await page.waitForFunction(() => (window.__GAME_TEST__?.getState()?.x ?? 0) > 690, { timeout: 5_000 });
  await page.keyboard.up("ArrowRight");
  await expect.poll(async () => (await readState(page)).y, { timeout: 5_000 }).toBeGreaterThan(480);
  const landed = await readState(page);
  if (landed.score < 3) {
    if (landed.x > 705) {
      await page.keyboard.down("ArrowLeft");
      await page.waitForFunction(() => (window.__GAME_TEST__?.getState()?.x ?? Number.MAX_SAFE_INTEGER) <= 700, { timeout: 1_000 });
      await page.keyboard.up("ArrowLeft");
    } else {
      await page.keyboard.down("ArrowRight");
      await page.waitForFunction(() => (window.__GAME_TEST__?.getState()?.x ?? 0) >= 710, { timeout: 1_000 });
      await page.keyboard.up("ArrowRight");
    }
    await expect.poll(async () => (await readState(page)).score).toBe(3);
  }
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await readState(page)).phase, { timeout: 15_000 }).toBe("won");
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("r");
  await expect.poll(async () => readState(page)).toMatchObject({ phase: "playing", lives: 3, score: 0 });
});

async function readState(page: import("playwright/test").Page): Promise<GameSnapshot> {
  return page.evaluate(() => {
    const state = window.__GAME_TEST__?.getState();
    if (!state) throw new Error("game_state_hook_unavailable");
    return state;
  });
}
