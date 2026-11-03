import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, test } from "playwright/test";
import { parseGeneratedSpritesheetAtlas } from "../../packages/game-templates/phaser/src/game/generated-assets";
import type { DefineAnimationResult } from "@meta-game/contracts";
import type { GeneratedAnimationManifest } from "../../packages/game-templates/phaser/src/game/generated-animations";

type SpritesheetArtifact = {
  result: {
    atlasAssetId: string;
    textureAssetId: string;
    atlasPath: string;
    imagePath: string;
    sha256: string;
    width: number;
    height: number;
    frames: Array<{ frameName: string; x: number; y: number; width: number; height: number }>;
  };
  imageBase64: string;
  atlasBase64: string;
  animationResult: DefineAnimationResult;
  animationManifestBase64: string;
};
type TilemapArtifact = {
  tilemapBase64: string;
  tilesetImageBase64: string;
  tilesetMetadataBase64: string;
};

const spritesheetArtifactPath = process.env.ISSUE_34_SPRITESHEET_PREVIEW_ARTIFACT;
const tilemapArtifactPath = process.env.ISSUE_33_TILEMAP_PREVIEW_ARTIFACT;

test("pack_spritesheet Silo output loads in Phaser 3.90 with exact frames, animation timing, rendered tiles, and collisions", async ({ page, baseURL }) => {
  test.skip(!spritesheetArtifactPath || !tilemapArtifactPath, "Run npm run test:assets:acceptance to load the PostgreSQL/Silo artifacts.");
  const spritesheet = JSON.parse(await readFile(spritesheetArtifactPath!, "utf8")) as SpritesheetArtifact;
  const tilemap = JSON.parse(await readFile(tilemapArtifactPath!, "utf8")) as TilemapArtifact;
  const image = Buffer.from(spritesheet.imageBase64, "base64");
  const atlasBytes = Buffer.from(spritesheet.atlasBase64, "base64");
  const animationBytes = Buffer.from(spritesheet.animationManifestBase64, "base64");
  const animationManifest = JSON.parse(animationBytes.toString("utf8")) as GeneratedAnimationManifest;
  const atlas = JSON.parse(atlasBytes.toString("utf8")) as unknown;
  const parsedAtlas = parseGeneratedSpritesheetAtlas(atlas);
  const decoded = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  expect(parsedAtlas).toBeDefined();
  expect(animationManifest.atlasAssetId).toBe(spritesheet.result.atlasAssetId);
  expect(animationManifest.animationManifestAssetId).toBe(spritesheet.animationResult.animationManifestAssetId);
  expect(spritesheet.animationResult.atlasAssetId).toBe(spritesheet.result.atlasAssetId);
  expect(createHash("sha256").update(animationBytes).digest("hex")).toBe(spritesheet.animationResult.sha256);
  expect(animationManifest.animations).toMatchObject([
    { key: "acceptance-run", frameNames: ["run_0", "run_1", "run_2"], frameRate: 6, repeat: -1, yoyo: false },
    { key: "acceptance-yoyo", frameNames: ["run_0", "run_1"], frameRate: 8, repeat: 1, yoyo: true, delayMs: 50, repeatDelayMs: 25 },
  ]);
  expect(spritesheet.result.sha256).toBeTruthy();
  expect(decoded.info).toMatchObject({ width: spritesheet.result.width, height: spritesheet.result.height, channels: 4 });
  expect(parsedAtlas).toMatchObject({
    image: spritesheet.result.textureAssetId + ".png",
    width: spritesheet.result.width,
    height: spritesheet.result.height,
    frameNames: ["run_0", "run_1", "run_2", "run_3"],
  });
  for (let leftIndex = 0; leftIndex < spritesheet.result.frames.length; leftIndex += 1) {
    const left = spritesheet.result.frames[leftIndex]!;
    expect(left.x + left.width).toBeLessThanOrEqual(spritesheet.result.width);
    expect(left.y + left.height).toBeLessThanOrEqual(spritesheet.result.height);
    for (let rightIndex = leftIndex + 1; rightIndex < spritesheet.result.frames.length; rightIndex += 1) {
      const right = spritesheet.result.frames[rightIndex]!;
      const overlaps = left.x < right.x + right.width && left.x + left.width > right.x &&
        left.y < right.y + right.height && left.y + left.height > right.y;
      expect(overlaps).toBe(false);
    }
  }

  await page.route("**/fixtures/generated-spritesheet.png", (route) => route.fulfill({
    status: 200, contentType: "image/png", body: image,
  }));
  await page.route("**/fixtures/generated-spritesheet.json", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: atlasBytes,
  }));
  await page.route("**/fixtures/generated-animation.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: animationBytes,
  }));
  await page.route("**/fixtures/generated-tilemap.json", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: Buffer.from(tilemap.tilemapBase64, "base64"),
  }));
  await page.route("**/fixtures/generated-map-tileset.png", (route) => route.fulfill({
    status: 200, contentType: "image/png", body: Buffer.from(tilemap.tilesetImageBase64, "base64"),
  }));
  await page.route("**/fixtures/generated-map-tileset.json", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: Buffer.from(tilemap.tilesetMetadataBase64, "base64"),
  }));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.clock.install({ time: new Date("2026-11-03T00:00:00.000Z") });
  await page.goto(new URL("/?mode=packed-spritesheet", baseURL ?? "http://127.0.0.1:4175").toString());
  await page.clock.runFor(1_500);
  await page.waitForFunction(() => window.__ASSET_PREVIEW_TEST__?.().loaded === true, undefined, { timeout: 10_000 });
  await page.waitForFunction(() => new Set(window.__ASSET_PREVIEW_TEST__?.().observedFrames.map(({ name }) => name)).size >= 3, undefined, { timeout: 5_000 });
  await page.waitForFunction(() => (window.__ASSET_PREVIEW_TEST__?.().observedFrames.filter(({ name }) => name === "run_1").length ?? 0) >= 4, undefined, { timeout: 8_000 });
  await page.waitForFunction(() => {
    const state = window.__ASSET_PREVIEW_TEST__?.();
    return Boolean(state?.tilemap && state.playerBottom >= 63.5 && state.playerBottom <= 64.5 && state.tilemap.freePlayerBottom > 70);
  }, undefined, { timeout: 8_000 });
  await page.waitForFunction(() => {
    const frames = window.__ASSET_PREVIEW_TEST__?.().yoyoObservedFrames ?? [];
    return frames.includes("run_1") && frames.filter((name) => name === "run_0").length >= 2;
  }, undefined, { timeout: 8_000 });
  const state = await page.evaluate(() => window.__ASSET_PREVIEW_TEST__?.());
  expect(pageErrors).toEqual([]);
  expect(state).toMatchObject({
    loaded: true,
    atlasValid: true,
    atlasTextureSize: { width: spritesheet.result.width, height: spritesheet.result.height },
    atlasFrames: ["run_0", "run_1", "run_2", "run_3"],
    animationFrames: ["run_0", "run_1", "run_2"],
    animationFps: 6,
    animationRuntime: { keys: ["acceptance-run", "acceptance-yoyo"], frameOrder: ["run_0", "run_1", "run_2"], repeat: -1, yoyo: false, delay: 0, repeatDelay: 0 },
    collisionEnabled: true,
    floorTop: 64,
    tilemap: {
      width: 8,
      height: 6,
      tileSize: 16,
      firstgid: 1,
      layerNames: ["background", "hidden", "ground", "props"],
      layerVisibility: [true, false, true, true],
      layerCollision: [false, false, true, false],
      floorTileIndex: 2,
      emptyTileIndex: -1,
      unselectedSolidTileCollides: false,
    },
  });
  expect(state?.playerBottom).toBeCloseTo(64, 0);
  expect(state?.tilemap?.freePlayerBottom).toBeGreaterThan(70);
  for (const frame of spritesheet.result.frames) {
    expect(state?.pivots[frame.frameName]).toEqual({ custom: true, x: 0.5, y: 1 });
    expect(parsedAtlas?.frames[frame.frameName]).toMatchObject({
      x: frame.x, y: frame.y, width: frame.width, height: frame.height, pivotX: 0.5, pivotY: 1,
    });
  }
  const observed = state?.observedFrames ?? [];
  const orderedTriple = observed.slice(0, -2).some((sample, index) =>
    sample.name === "run_0" && observed[index + 1]?.name === "run_1" && observed[index + 2]?.name === "run_2");
  expect(orderedTriple).toBe(true);
  expect(state?.yoyoObservedFrames?.slice(0, 3)).toEqual(["run_0", "run_1", "run_0"]);
  expect(state?.yoyoRuntime).toMatchObject({ frameOrder: ["run_0", "run_1"], frameRate: 8, repeat: 1, yoyo: true, delay: 50, repeatDelay: 25 });
  const runOneTimes = observed.filter(({ name }) => name === "run_1").map(({ at }) => at);
  const intervals = runOneTimes.slice(1).map((time, index) => time - runOneTimes[index]!);
  const medianCycleMs = median(intervals);
  expect(medianCycleMs).toBeGreaterThan(430);
  expect(medianCycleMs).toBeLessThan(650);

  const evidenceDirectory = path.resolve(process.cwd(), "docs/evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const screenshotPath = path.join(evidenceDirectory, "issue-35-phaser-animations.png");
  const screenshot = await page.locator("canvas").screenshot({ path: screenshotPath });
  const renderedColors: number[][] = [];
  for (const x of [8, 24, 40, 56]) {
    renderedColors.push([...await sharp(screenshot).extract({ left: x, top: 8, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]);
  }
  expect(renderedColors).toEqual([
    [35, 115, 230],
    [38, 220, 80],
    [190, 70, 225],
    [230, 190, 35],
  ]);

  const animationKeysBeforeRestart = state?.animationRuntime?.keys;
  await page.evaluate(() => window.__ASSET_PREVIEW_RESTART__?.());
  await page.clock.runFor(500);
  await page.waitForFunction(() => window.__ASSET_PREVIEW_TEST__?.().sceneCreateCount === 2, undefined, { timeout: 8_000 });
  const restarted = await page.evaluate(() => window.__ASSET_PREVIEW_TEST__?.());
  expect(restarted?.loaded).toBe(true);
  expect(restarted?.animationRuntime?.keys).toEqual(animationKeysBeforeRestart);
  expect(pageErrors).toEqual([]);

  const report = [
    "# Evidencia de aceptación #35",
    "",
    "Fecha UTC: " + new Date().toISOString(),
    "",
    "pack_spritesheet procesó cuatro frames privados y define_animation validó el atlas registrado de PostgreSQL/Silo y guardó su manifiesto versionado también en PostgreSQL/Silo. Phaser 3.90 cargó los bytes exactos en la preview.",
    "Atlas: cuatro rectángulos con dimensiones originales; Phaser resolvió run_0, run_1, run_2 y run_3, todos dentro de la textura, sin solapes y con pivote (0.5, 1).",
    "Animación: acceptance-run recorrió run_0 → run_1 → run_2 a 6 fps (ciclo mediano " + medianCycleMs.toFixed(1) + " ms); acceptance-yoyo validó run_0 → run_1 → run_0, repeat=1, yoyo, 8 fps y delays de 50/25 ms. La escena se reinició conservando solo las dos claves.",
    "Tilemap y tileset de #33 recuperados de Silo: las cuatro muestras renderizadas fueron RGB " + renderedColors.map((color) => "(" + color.join(",") + ")").join(", ") + ". El actor cayó y quedó en y=" + (state?.playerBottom ?? 0).toFixed(1) + " sobre ground; la capa props no activó colisión.",
    "La integración creó los PNG sintéticos localmente y los subió a PostgreSQL/Silo; no llamó a Meta ni utilizó un mock de almacenamiento.",
    "",
    "Captura: docs/evidence/issue-35-phaser-animations.png.",
    "",
  ].join("\n");
  await writeFile(path.join(evidenceDirectory, "issue-35-phaser-animations.md"), report, "utf8");
});

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
