import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, test } from "playwright/test";
import type { InspectAssetInput } from "@meta-game/contracts";
import type { RunWorkerClaim, VerifiedIdentityContext } from "@meta-game/db";
import { createInspectAssetTool } from "../../apps/worker/src/assets/inspect-asset";

const projectId = "00000000-0000-4000-8000-000000000801";
const checks = ["decode", "dimensions", "alpha", "frame-grid", "atlas-references", "tileset-grid", "tilemap-bounds", "animation-frame-names"] as const;

test("inspect_asset output loads in a Phaser 3.90 preview with ordered animation, pivots and colliding tiles", async ({ page, baseURL }) => {
  const heroBytes = await makeStrip([
    { r: 35, g: 115, b: 230, alpha: 1 },
    { r: 235, g: 185, b: 40, alpha: 1 },
    { r: 180, g: 70, b: 225, alpha: 1 },
  ]);
  const terrainBytes = await makeTiles();
  const atlas = {
    frames: Object.fromEntries(["run_0", "run_1", "run_2"].map((filename, index) => [filename, {
      frame: { x: index * 16, y: 0, w: 16, h: 16 },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 },
      sourceSize: { w: 16, h: 16 },
      pivot: { x: 0.5, y: 1 },
    }])),
    meta: { image: "hero.png", size: { w: 48, h: 16 }, format: "RGBA8888", scale: "1" },
  };
  const animation = { key: "hero-run", atlasPath: "../atlases/hero.json", fps: 6, frames: ["run_0", "run_1", "run_2"] };
  const tileset = {
    name: "terrain", image: "terrain.png", tileWidth: 16, tileHeight: 16,
    tilewidth: 16, tileheight: 16, tilecount: 2, columns: 2, margin: 0, spacing: 0,
    tiles: [{ id: 1, collides: true }],
  };
  const groundTiles = Array.from({ length: 8 }, (_, x) => ({ x, y: 4, index: 1 }));
  const tilemap = {
    schemaVersion: 1, width: 8, height: 6, tileWidth: 16, tileHeight: 16,
    tilesetPath: "../tilesets/terrain.json",
    layers: [{ name: "ground", collides: true, tiles: groundTiles }],
  };
  const files = new Map<string, string | Uint8Array>([
    ["public/assets/generated/hero-preview.png", heroBytes],
    ["public/assets/atlases/hero.json", JSON.stringify(atlas)],
    ["public/assets/atlases/hero.png", heroBytes],
    ["public/assets/animations/run.json", JSON.stringify(animation)],
    ["public/assets/tilesets/terrain.json", JSON.stringify(tileset)],
    ["public/assets/tilesets/terrain.png", terrainBytes],
    ["public/assets/tilemaps/level.json", JSON.stringify(tilemap)],
  ]);
  const sandbox = {
    async readFile(_project: string, assetPath: string) {
      const content = files.get(assetPath);
      if (typeof content !== "string") throw new Error("file_not_found");
      return { path: assetPath, content };
    },
    async readBinaryFile(_project: string, assetPath: string) {
      const content = files.get(assetPath);
      if (!(content instanceof Uint8Array)) throw new Error("file_not_found");
      return content;
    },
  };
  const claim: RunWorkerClaim = {
    runId: "00000000-0000-4000-8000-000000000802",
    ownerUserId: "user_assetPreviewFixture",
    projectId,
    fencingToken: 1,
  };
  const tool = createInspectAssetTool({
    sandbox,
    storage: { async read() { throw new Error("unexpected_private_asset_read"); } },
    identity: async () => ({} as VerifiedIdentityContext),
  });
  const entries: InspectAssetInput[] = [
    { workspacePath: "public/assets/generated/hero-preview.png", kind: "image", checks: ["decode", "dimensions", "alpha"] },
    { workspacePath: "public/assets/atlases/hero.json", kind: "atlas", checks: [...checks] },
    { workspacePath: "public/assets/animations/run.json", kind: "animation", checks: [...checks] },
    { workspacePath: "public/assets/tilesets/terrain.json", kind: "tileset", checks: [...checks] },
    { workspacePath: "public/assets/tilemaps/level.json", kind: "tilemap", checks: [...checks] },
  ];
  const inspectionResults = await Promise.all(entries.map((entry) => tool(entry, { claim, projectId, signal: new AbortController().signal })));
  expect(inspectionResults.map((result) => result.status)).toEqual(["valid", "valid", "valid", "valid", "valid"]);
  expect(inspectionResults[1]).toMatchObject({ frameCount: 3, dimensions: { width: 48, height: 16 } });
  expect(inspectionResults[4]).toMatchObject({ dimensions: { width: 128, height: 96 }, frameCount: 8 });

  const routes = new Map<string, { contentType: string; body: string | Uint8Array }>([
    ["/fixtures/hero.json", { contentType: "application/json", body: JSON.stringify(atlas) }],
    ["/fixtures/hero.png", { contentType: "image/png", body: heroBytes }],
    ["/fixtures/run.json", { contentType: "application/json", body: JSON.stringify(animation) }],
    ["/fixtures/terrain.json", { contentType: "application/json", body: JSON.stringify(tileset) }],
    ["/fixtures/terrain.png", { contentType: "image/png", body: terrainBytes }],
    ["/fixtures/level.json", { contentType: "application/json", body: JSON.stringify(tilemap) }],
  ]);
  await page.route("**/fixtures/*", async (route) => {
    const resource = routes.get(new URL(route.request().url()).pathname);
    if (!resource) return route.fulfill({ status: 404, body: "not_found" });
    return route.fulfill({ status: 200, contentType: resource.contentType, body: typeof resource.body === "string" ? resource.body : Buffer.from(resource.body) });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseURL!);
  await page.waitForFunction(() => window.__ASSET_PREVIEW_TEST__?.().loaded === true, undefined, { timeout: 10_000 });
  await page.waitForFunction(() => new Set(window.__ASSET_PREVIEW_TEST__?.().observedFrames.map(({ name }) => name)).size === 3, undefined, { timeout: 5_000 });
  await page.waitForFunction(() => (window.__ASSET_PREVIEW_TEST__?.().observedFrames.filter(({ name }) => name === "run_1").length ?? 0) >= 4, undefined, { timeout: 5_000 });
  await page.waitForFunction(() => Math.abs((window.__ASSET_PREVIEW_TEST__?.().playerBottom ?? 0) - (window.__ASSET_PREVIEW_TEST__?.().floorTop ?? 64)) < 2, undefined, { timeout: 8_000 });

  const state = await page.evaluate(() => window.__ASSET_PREVIEW_TEST__?.());
  expect(pageErrors).toEqual([]);
  expect(state).toMatchObject({ loaded: true, atlasFrames: ["run_0", "run_1", "run_2"], animationFrames: ["run_0", "run_1", "run_2"], animationFps: 6, collisionEnabled: true });
  expect(state?.pivots).toEqual({
    run_0: { custom: true, x: 0.5, y: 1 },
    run_1: { custom: true, x: 0.5, y: 1 },
    run_2: { custom: true, x: 0.5, y: 1 },
  });
  expect(state?.playerBottom).toBeCloseTo(state?.floorTop ?? 0, 0);

  const observed = state?.observedFrames ?? [];
  const orderedTriples = observed.slice(0, -2).some((sample, index) =>
    sample.name === "run_0" && observed[index + 1]?.name === "run_1" && observed[index + 2]?.name === "run_2");
  expect(orderedTriples).toBe(true);
  const runOneTimes = observed.filter((sample) => sample.name === "run_1").map((sample) => sample.at);
  const frameIntervals = runOneTimes.slice(1).map((time, index) => time - runOneTimes[index]!);
  const medianFrameInterval = median(frameIntervals);
  expect(medianFrameInterval).toBeGreaterThan(430);
  expect(medianFrameInterval).toBeLessThan(650);

  const evidenceDir = path.resolve(process.cwd(), "docs/evidence");
  await mkdir(evidenceDir, { recursive: true });
  const screenshotPath = path.join(evidenceDir, "issue-30-phaser-assets.png");
  const screenshot = await page.locator("canvas").screenshot({ path: screenshotPath });
  const sampled = await sharp(screenshot).extract({ left: 8, top: 72, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  expect(sampled[1]).toBeGreaterThan(150);
  expect(sampled[0]).toBeLessThan(100);
  const report = [
    "# Evidencia de aceptación #30",
    "",
    `Fecha UTC: ${new Date().toISOString()}`,
    "",
    "La tool `inspect_asset` recorrió imágenes, atlas, animación, tileset y tilemap con PNG reales generados para esta prueba; los cinco reportes fueron `valid`.",
    `Atlas: ${state?.atlasFrames.length ?? 0} frames Phaser cargados; cada pivote quedó en (0.5, 1); los rectángulos y límites pasaron el inspector. SHA-256 del descriptor del atlas: ${inspectionResults[1]?.sha256 ?? "ausente"}.`,
    `Animación: secuencia observada run_0 → run_1 → run_2 a ${state?.animationFps ?? 0} fps; mediana observada de un ciclo: ${medianFrameInterval.toFixed(1)} ms.`,
    `Tileset/tilemap: ${tileset.tilecount} tiles, ${groundTiles.length} celdas de colisión; el jugador aterrizó en y=${(state?.floorTop ?? 0).toFixed(1)} y la muestra de render fue RGB(${sampled[0]}, ${sampled[1]}, ${sampled[2]}).`,
    "Runtime: preview local Phaser 3.90.0 en Vite y Chromium Playwright. Los archivos de entrada son fixtures generados por sharp; Meta no fue llamado ni se cobró uso.",
    "",
    "Captura: `docs/evidence/issue-30-phaser-assets.png`.",
    "",
  ].join("\n");
  await writeFile(path.join(evidenceDir, "issue-30-asset-inspection.md"), report, "utf8");
});

async function makeStrip(colors: readonly { r: number; g: number; b: number; alpha: number }[]): Promise<Buffer> {
  const raw = Buffer.alloc(48 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 48; x += 1) {
      const color = colors[Math.floor(x / 16)]!;
      const offset = (y * 48 + x) * 4;
      raw[offset] = color.r;
      raw[offset + 1] = color.g;
      raw[offset + 2] = color.b;
      raw[offset + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: 48, height: 16, channels: 4 } }).png().toBuffer();
}

async function makeTiles(): Promise<Buffer> {
  const raw = Buffer.alloc(32 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const offset = (y * 32 + x) * 4;
      raw[offset] = x < 16 ? 190 : 38;
      raw[offset + 1] = x < 16 ? 70 : 220;
      raw[offset + 2] = x < 16 ? 60 : 80;
      raw[offset + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: 32, height: 16, channels: 4 } }).png().toBuffer();
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
}
