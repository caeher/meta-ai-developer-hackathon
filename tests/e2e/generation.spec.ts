import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "playwright/test";
import type { GameGenre, GameSnapshot } from "../../packages/game-templates/phaser/src/game/types";

declare global {
  interface Window {
    __GAME_TEST__?: Readonly<{ getState: () => GameSnapshot | null }>;
  }
}

const genres: readonly GameGenre[] = ["platformer", "puzzle", "shooter", "rpg"];

test("los cuatro presets cargan el loop, publican controles y responden a teclado y touch sin salir de preview", async ({ page, baseURL }) => {
  let blockedRequests = 0;
  const consoleErrors: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === new URL(baseURL!).port) return route.continue();
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    blockedRequests += 1;
    return route.abort("blockedbyclient");
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

  for (const genre of genres) {
    await page.goto(`/?genre=${genre}`);
    await page.waitForFunction(() => window.__GAME_TEST__?.getState()?.assetsReady === true);
    await expect(page.locator("#game canvas")).toBeVisible();
    await expect(page.locator("#game-controls")).toBeVisible();
    await expect(page.locator('#touch-controls button[data-control="right"]')).toBeVisible();
    await expect(page.locator('#touch-controls button[data-control="action"]')).toBeVisible();
    expect(await readState(page)).toMatchObject({ genre, phase: "playing", target: expect.any(Number), assetsReady: true });

    const initial = await readState(page);
    await page.keyboard.down("ArrowRight");
    try {
      await expect.poll(async () => (await readState(page)).x, { timeout: 2_000 }).not.toBe(initial.x);
    } finally {
      await page.keyboard.up("ArrowRight");
    }

    const beforeTouch = await readState(page);
    const touchRight = page.locator('#touch-controls button[data-control="right"]');
    const touchBox = await touchRight.boundingBox();
    expect(touchBox).not.toBeNull();
    await page.mouse.move(touchBox!.x + touchBox!.width / 2, touchBox!.y + touchBox!.height / 2);
    await page.mouse.down();
    try {
      await expect.poll(async () => (await readState(page)).x, { timeout: 2_000 }).not.toBe(beforeTouch.x);
    } finally {
      await page.mouse.up();
    }
    await expect(page.getByRole("button", { name: "Reiniciar juego" })).toBeVisible();
  }
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const serious = audit.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious");
  expect(serious.map((violation) => ({ rule: violation.id, help: violation.help, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(blockedRequests).toBe(0);
});

async function readState(page: import("playwright/test").Page): Promise<GameSnapshot> {
  return page.evaluate(() => {
    const state = window.__GAME_TEST__?.getState();
    if (!state) throw new Error("game_state_hook_unavailable");
    return state;
  });
}
