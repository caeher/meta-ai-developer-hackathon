import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, test } from "playwright/test";
import { identityFromAuthenticatedSession, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import type { MetaImageResult } from "@meta-game/contracts";
import { createEditSpriteTool } from "../../apps/worker/src/assets/edit-sprite";
import { createInspectAssetTool } from "../../apps/worker/src/assets/inspect-asset";

const projectId = "00000000-0000-4000-8000-000000000321";
const ownerId = "user_spritePreviewFixture001";
const sourceAssetId = "00000000-0000-4000-8000-000000000322";
const identity = identityFromAuthenticatedSession({ userId: ownerId });
const claim: RunWorkerClaim = {
  runId: "00000000-0000-4000-8000-000000000323",
  ownerUserId: ownerId,
  projectId,
  fencingToken: 1,
};
const checks = ["decode", "dimensions", "alpha", "frame-grid", "atlas-references", "tileset-grid", "tilemap-bounds", "animation-frame-names"] as const;

test("edit_sprite result loads in Phaser and passes atlas, animation and tile preview checks", async ({ page, baseURL }) => {
  const sourceBytes = await makeStrip([
    { r: 35, g: 115, b: 230 },
    { r: 235, g: 185, b: 40 },
    { r: 180, g: 70, b: 225 },
  ]);
  const sourceSha256 = sha256(sourceBytes);
  const sourceMetadata = {
    schemaVersion: 1,
    source: "meta-model-api",
    assetType: "sprite",
    model: "muse-image-1.0",
    prompt: "A source hero sprite for a Phaser preview fixture.",
    createdAt: "2026-11-02T12:00:00.000Z",
    responseId: "resp_sprite_preview_source",
    originalMimeType: "image/png",
    mimeType: "image/png",
    originalSha256: sourceSha256,
    sha256: sourceSha256,
    width: 48,
    height: 16,
    hasAlpha: true,
    transparentPixels: false,
    requestedTransparency: false,
    frames: { columns: 3, rows: 1, frameWidth: 16, frameHeight: 16 },
    edits: ["metadata-stripped", "png-reencoded"],
    qa: { contactSheetAssetId: "00000000-0000-4000-8000-000000000324", contactSheetSha256: sha256(Buffer.from("source-contact")), visualReview: "pending-in-live-preview" },
  };
  const assets = new Map<string, { id: string; projectId: string; contentType: string; sizeBytes: number; sha256: string; metadata: Record<string, unknown>; body: Buffer }>();
  assets.set(sourceAssetId, {
    id: sourceAssetId, projectId, contentType: "image/png", sizeBytes: sourceBytes.byteLength,
    sha256: sourceSha256, metadata: sourceMetadata, body: sourceBytes,
  });
  const workspaceFiles = new Map<string, string | Uint8Array>();
  const manifest = JSON.stringify({
    schemaVersion: 1,
    assets: [{ assetId: sourceAssetId, key: `generated-${sourceAssetId}`, path: `assets/generated/${sourceAssetId}.png`, assetType: "sprite", frameColumns: 3, frameRows: 1, frameWidth: 16, frameHeight: 16 }],
  });
  workspaceFiles.set("public/assets/generated/manifest.json", manifest);
  const storedSourceBefore = Buffer.from(assets.get(sourceAssetId)!.body);
  const sandbox = {
    async readFile(_project: string, assetPath: string) {
      const value = workspaceFiles.get(assetPath);
      if (typeof value !== "string") throw new Error("file_not_found");
      return { path: assetPath, content: value };
    },
    async readBinaryFile(_project: string, assetPath: string) {
      const value = workspaceFiles.get(assetPath);
      if (!(value instanceof Uint8Array)) throw new Error("file_not_found");
      return value;
    },
    async writeBinaryFile(_project: string, assetPath: string, bytes: Uint8Array) {
      workspaceFiles.set(assetPath, Buffer.from(bytes));
      return { path: assetPath, bytesWritten: bytes.byteLength };
    },
    async writeFile(_project: string, assetPath: string, content: string) {
      workspaceFiles.set(assetPath, content);
      return { path: assetPath, bytesWritten: Buffer.byteLength(content, "utf8") };
    },
  };
  const storage = {
    async read(_providedIdentity: VerifiedIdentityContext, assetId: string) {
      const asset = assets.get(assetId);
      if (!asset) throw new Error("asset_not_found");
      return { asset, body: asset.body };
    },
    async upload(_providedIdentity: VerifiedIdentityContext, request: { projectId: string; contentType: "image/png"; body: Uint8Array; metadata: Record<string, unknown> }) {
      const id = randomUUID();
      const body = Buffer.from(request.body);
      const checksum = sha256(body);
      assets.set(id, { id, projectId: request.projectId, contentType: request.contentType, sizeBytes: body.byteLength, sha256: checksum, metadata: request.metadata, body });
      return { id, sha256: checksum, status: "ready" as const };
    },
    async delete(_providedIdentity: VerifiedIdentityContext, assetId: string) { assets.delete(assetId); },
  };
  const editedPixels = { r: 25, g: 170, b: 160 };
  const metaImage = await makeFrame(editedPixels);
  const expectedReference = await cropFrame(sourceBytes, 1);
  const editImage = async (_prompt: string, reference: { mimeType: "image/png"; bytes: Uint8Array }, _options: { signal: AbortSignal }): Promise<MetaImageResult> => {
    void _options;
    expect(Buffer.from(reference.bytes)).toEqual(expectedReference);
    return { bytes: metaImage, mimeType: "image/png", width: 16, height: 16, model: "muse-image-1.0", responseId: "resp_sprite_preview_edit", requestId: "req_sprite_preview_edit", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
  };
  const toolContext = {
    claim,
    projectId,
    signal: new AbortController().signal,
    beforeRequest: async () => undefined,
    onResponse: async () => undefined,
  };
  const editTool = createEditSpriteTool({ meta: { editImage }, storage, sandbox, identity: async () => identity });
  const edited = await editTool({
    sourceAssetId,
    sourceFrameIndex: 1,
    requestedChange: "Change the hero scarf to teal while preserving its outline.",
    palette: ["#19aaa0"],
    preserve: { canvas: true, style: true, palette: true, characterIdentity: true },
  }, toolContext);
  const editedAsset = assets.get(edited.assetId)!;
  expect(editedAsset.body).not.toEqual(sourceBytes);
  expect(assets.get(sourceAssetId)!.body).toEqual(storedSourceBefore);
  expect(edited).toMatchObject({ sourceAssetId, sourceSha256, provenance: "meta-image-edit", width: 16, height: 16 });

  const [firstFrame, lastFrame] = await Promise.all([cropFrame(sourceBytes, 0), cropFrame(sourceBytes, 2)]);
  const atlasBytes = await sharp({ create: { width: 48, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: firstFrame, left: 0, top: 0 },
      { input: editedAsset.body, left: 16, top: 0 },
      { input: lastFrame, left: 32, top: 0 },
    ]).png().toBuffer();
  const atlas = {
    frames: Object.fromEntries(["run_0", "run_1", "run_2"].map((filename, index) => [filename, {
      frame: { x: index * 16, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: 16, h: 16 }, sourceSize: { w: 16, h: 16 }, pivot: { x: 0.5, y: 1 },
    }])),
    meta: { image: "hero.png", size: { w: 48, h: 16 }, format: "RGBA8888", scale: "1" },
  };
  const animation = { key: "hero-run", atlasPath: "../atlases/hero.json", fps: 6, frames: ["run_0", "run_1", "run_2"] };
  const terrainBytes = await makeTiles();
  const tileset = { name: "terrain", image: "terrain.png", tileWidth: 16, tileHeight: 16, tilewidth: 16, tileheight: 16, tilecount: 2, columns: 2, margin: 0, spacing: 0, tiles: [{ id: 1, collides: true }] };
  const groundTiles = Array.from({ length: 8 }, (_, x) => ({ x, y: 4, index: 1 }));
  const tilemap = { schemaVersion: 1, width: 8, height: 6, tileWidth: 16, tileHeight: 16, tilesetPath: "../tilesets/terrain.json", layers: [{ name: "ground", collides: true, tiles: groundTiles }] };
  const files = new Map<string, string | Uint8Array>([
    [`public/${edited.path}`, editedAsset.body],
    ["public/assets/atlases/hero.json", JSON.stringify(atlas)],
    ["public/assets/atlases/hero.png", atlasBytes],
    ["public/assets/animations/run.json", JSON.stringify(animation)],
    ["public/assets/tilesets/terrain.json", JSON.stringify(tileset)],
    ["public/assets/tilesets/terrain.png", terrainBytes],
    ["public/assets/tilemaps/level.json", JSON.stringify(tilemap)],
  ]);
  for (const [file, value] of files) workspaceFiles.set(file, value);
  const inspectTool = createInspectAssetTool({ sandbox, storage, identity: async () => identity });
  const inspectionResults = await Promise.all([
    inspectTool({ assetId: edited.assetId, kind: "image", checks: ["decode", "dimensions", "alpha", "frame-grid"] }, { claim, projectId, signal: toolContext.signal }),
    ...[
      ["public/assets/atlases/hero.json", "atlas"],
      ["public/assets/animations/run.json", "animation"],
      ["public/assets/tilesets/terrain.json", "tileset"],
      ["public/assets/tilemaps/level.json", "tilemap"],
    ].map(([workspacePath, kind]) => inspectTool({ workspacePath, kind, checks: [...checks] }, { claim, projectId, signal: toolContext.signal })),
  ]);
  expect(inspectionResults.map((result) => result.status)).toEqual(["valid", "valid", "valid", "valid", "valid"]);
  expect(inspectionResults[0]).toMatchObject({ sha256: edited.sha256, dimensions: { width: 16, height: 16 } });
  expect(inspectionResults[1]).toMatchObject({ frameCount: 3, dimensions: { width: 48, height: 16 } });

  const routes = new Map<string, { contentType: string; body: string | Uint8Array }>([
    ["/fixtures/hero.json", { contentType: "application/json", body: JSON.stringify(atlas) }],
    ["/fixtures/hero.png", { contentType: "image/png", body: atlasBytes }],
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
  expect(state?.pivots).toEqual({ run_0: { custom: true, x: 0.5, y: 1 }, run_1: { custom: true, x: 0.5, y: 1 }, run_2: { custom: true, x: 0.5, y: 1 } });
  expect(state?.playerBottom).toBeCloseTo(state?.floorTop ?? 0, 0);
  const observed = state?.observedFrames ?? [];
  const orderedTriples = observed.slice(0, -2).some((sample, index) => sample.name === "run_0" && observed[index + 1]?.name === "run_1" && observed[index + 2]?.name === "run_2");
  expect(orderedTriples).toBe(true);
  const runOneTimes = observed.filter((sample) => sample.name === "run_1").map((sample) => sample.at);
  const medianFrameInterval = median(runOneTimes.slice(1).map((time, index) => time - runOneTimes[index]!));
  expect(medianFrameInterval).toBeGreaterThan(430);
  expect(medianFrameInterval).toBeLessThan(650);

  await page.waitForFunction(() => window.__ASSET_PREVIEW_TEST__?.().observedFrames.at(-1)?.name === "run_1", undefined, { timeout: 1_000 });
  const evidenceDir = path.resolve(process.cwd(), "docs/evidence");
  await mkdir(evidenceDir, { recursive: true });
  const screenshotPath = path.join(evidenceDir, "issue-31-sprite-edit-preview.png");
  const screenshot = await page.locator("canvas").screenshot({ path: screenshotPath });
  const sampled = await sharp(screenshot).extract({ left: 8, top: 72, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  const editedSpritePixel = await sharp(screenshot).extract({ left: 24, top: 56, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  expect(sampled[1]).toBeGreaterThan(150);
  expect(sampled[0]).toBeLessThan(100);
  expect([...editedSpritePixel]).toEqual([editedPixels.r, editedPixels.g, editedPixels.b]);
  const report = [
    "# Evidencia de aceptación #31",
    "",
    `Fecha UTC: ${new Date().toISOString()}`,
    "",
    `La tool editó el frame 1 de un sprite privado de tres frames usando Meta mock; el mock verificó que la referencia enviada correspondía exactamente al assetId y frame pedidos. Hash de origen ${sourceSha256}; hash derivado ${edited.sha256}. El asset fuente permaneció byte por byte igual.`,
    `La inspección de la imagen editada, atlas, animación, tileset y tilemap produjo cinco reportes valid. Atlas Phaser: ${state?.atlasFrames.length ?? 0} frames, rectángulos sin solape ni desborde y pivotes (0.5, 1).`,
    `La captura se tomó mostrando run_1; el píxel central de ese frame en el canvas coincide con RGB(${editedSpritePixel[0]}, ${editedSpritePixel[1]}, ${editedSpritePixel[2]}) del PNG editado.`,
    `La animación recorrió run_0 → run_1 → run_2 a ${state?.animationFps ?? 0} fps; intervalo mediano observado del frame editado: ${medianFrameInterval.toFixed(1)} ms.`,
    `El tileset de ${tileset.tilecount} celdas se renderizó; ${groundTiles.length} celdas de suelo tuvieron colisión y el jugador aterrizó en y=${(state?.floorTop ?? 0).toFixed(1)}. Muestra del tile: RGB(${sampled[0]}, ${sampled[1]}, ${sampled[2]}).`,
    "Runtime: plantilla de preview Phaser 3.90.0, Vite y Playwright Chromium. No se llamó Meta ni se consumió cuota.",
    "",
    "Captura: `docs/evidence/issue-31-sprite-edit-preview.png`.",
    "",
  ].join("\n");
  await writeFile(path.join(evidenceDir, "issue-31-sprite-edit-preview.md"), report, "utf8");
});

async function makeStrip(colors: readonly { r: number; g: number; b: number }[]): Promise<Buffer> {
  const raw = Buffer.alloc(48 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 48; x += 1) {
      const color = colors[Math.floor(x / 16)]!;
      const offset = (y * 48 + x) * 4;
      raw[offset] = color.r; raw[offset + 1] = color.g; raw[offset + 2] = color.b; raw[offset + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: 48, height: 16, channels: 4 } }).png().toBuffer();
}

async function makeFrame(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer();
}

async function cropFrame(bytes: Uint8Array, index: number): Promise<Buffer> {
  return sharp(bytes).extract({ left: index * 16, top: 0, width: 16, height: 16 }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function makeTiles(): Promise<Buffer> {
  const raw = Buffer.alloc(32 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const offset = (y * 32 + x) * 4;
      raw[offset] = x < 16 ? 190 : 38; raw[offset + 1] = x < 16 ? 70 : 220; raw[offset + 2] = x < 16 ? 60 : 80; raw[offset + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: 32, height: 16, channels: 4 } }).png().toBuffer();
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function median(values: number[]): number { const sorted = [...values].sort((left, right) => left - right); return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0; }
