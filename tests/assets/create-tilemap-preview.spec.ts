import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, test } from "playwright/test";

type AcceptanceArtifact = {
  result: {
    tilemapAssetId: string;
    tilesetAssetId: string;
    path: string;
    sha256: string;
    width: number;
    height: number;
    tileSize: number;
    layerNames: string[];
    cellCount: number;
    collisionTileNames: string[];
    phaserFormat: "phaser-3-tilemap-json";
  };
  tilemapBase64: string;
  tilesetImageBase64: string;
  tilesetMetadataBase64: string;
};

const artifactPath = process.env.ISSUE_33_TILEMAP_PREVIEW_ARTIFACT;

test("create_tilemap output from PostgreSQL/Silo renders Tiled GIDs and applies selected-layer collisions in Phaser 3.90", async ({ page, baseURL }) => {
  test.skip(!artifactPath, "Run npm run test:assets:acceptance to load the PostgreSQL/Silo tilemap artifact.");
  const artifact = JSON.parse(await readFile(artifactPath!, "utf8")) as AcceptanceArtifact;
  const tilemap = Buffer.from(artifact.tilemapBase64, "base64");
  const image = Buffer.from(artifact.tilesetImageBase64, "base64");
  const metadataBytes = Buffer.from(artifact.tilesetMetadataBase64, "base64");
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as {
    engine: string;
    sha256: string;
    tileSize: number;
    tiles: Array<{ id: number; tileName: string; collides: boolean; terrain: string }>;
  };
  const decoded = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  expect(artifact.result).toMatchObject({ width: 8, height: 6, tileSize: 16, layerNames: ["background", "hidden", "ground", "props"], cellCount: 12, collisionTileNames: ["ground"] });
  expect(metadata.engine).toBe("phaser-3.90.0");
  expect(metadata.tiles.map(({ id }) => id)).toEqual([0, 1, 2, 3]);
  expect(decoded.info).toMatchObject({ width: 32, height: 32, channels: 4 });

  await page.route("**/fixtures/generated-tilemap.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: tilemap }));
  await page.route("**/fixtures/generated-map-tileset.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: image }));
  await page.route("**/fixtures/generated-map-tileset.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: metadataBytes }));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(new URL("/?mode=generated-tilemap", baseURL ?? "http://127.0.0.1:4175").toString());
  await page.waitForFunction(() => Boolean(window.__ASSET_PREVIEW_TEST__?.().loaded), undefined, { timeout: 10_000 });
  await page.waitForFunction(() => {
    const state = window.__ASSET_PREVIEW_TEST__?.();
    return Boolean(state?.tilemap && state.playerBottom >= 63 && state.playerBottom <= 65 && state.tilemap.freePlayerBottom > 70);
  }, undefined, { timeout: 8_000 });

  const state = await page.evaluate(() => window.__ASSET_PREVIEW_TEST__?.());
  expect(pageErrors).toEqual([]);
  expect(state).toMatchObject({
    loaded: true,
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
      backgroundIndices: [1, 2, 3, 4],
      floorTileIndex: 2,
      emptyTileIndex: -1,
      unselectedSolidTileCollides: false,
    },
  });
  expect(state?.playerBottom).toBeCloseTo(64, 0);
  expect(state?.tilemap?.freePlayerBottom).toBeGreaterThan(70);

  const evidenceDirectory = path.resolve(process.cwd(), "docs/evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const screenshotPath = path.join(evidenceDirectory, "issue-33-phaser-tilemap.png");
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
  const report = [
    "# Evidencia de aceptación #33",
    "",
    `Fecha UTC: ${new Date().toISOString()}`,
    "",
    "`create_tilemap` se ejecutó en la integración temporal de PostgreSQL/Silo. El resultado recuperado de Silo se cargó como Tiled JSON en Phaser 3.90 desde Vite y Chromium Playwright.",
    `Tilemap ${state?.tilemap?.width}×${state?.tilemap?.height}, tile ${state?.tilemap?.tileSize}px, firstgid ${state?.tilemap?.firstgid}; capas en orden ${state?.tilemap?.layerNames.join(" → ")}; ${artifact.result.cellCount} celdas no vacías y GID 0 para huecos.`,
    `Capas visibles: ${state?.tilemap?.layerVisibility.join(", ")}; colisión activada solo en ground. El actor cayó sobre ground hasta y=${(state?.playerBottom ?? 0).toFixed(1)}; el tile vacío y el tile sólido en props no bloquearon al segundo actor (y=${(state?.tilemap?.freePlayerBottom ?? 0).toFixed(1)}).`,
    `Render tile por tile, colores RGB: ${renderedColors.map((color) => `(${color.join(",")})`).join(", ")}. SHA-256 del JSON tilemap: ${artifact.result.sha256}.`,
    "El contrato de atlas y animación también se verificó en la misma aceptación mediante `inspect-preview.spec.ts`: rectángulos completos y sin solapes, pivotes (0.5, 1), secuencia run_0 → run_1 → run_2 y cadencia de 6 fps. Véase `docs/evidence/issue-30-asset-inspection.md`.",
    "No se llamó a Meta; las imágenes originales son píxeles sintéticos del fixture local. La tool de tilemap consumió el tileset privado producido y almacenado por la tool real `create_tileset` en la base y Silo temporales de Compose.",
    "",
    "Captura: `docs/evidence/issue-33-phaser-tilemap.png`.",
    "",
  ].join("\n");
  await writeFile(path.join(evidenceDirectory, "issue-33-phaser-tilemap.md"), report, "utf8");
});

test("Phaser runtime reports missing images and rejects a map linked to a different tileset", async ({ page, baseURL }) => {
  test.skip(!artifactPath, "Run npm run test:assets:acceptance to load the PostgreSQL/Silo tilemap artifact.");
  const artifact = JSON.parse(await readFile(artifactPath!, "utf8")) as AcceptanceArtifact;
  const tilemap = JSON.parse(Buffer.from(artifact.tilemapBase64, "base64").toString("utf8")) as {
    properties: Array<{ name: string; type: string; value: unknown }>;
  };
  const image = Buffer.from(artifact.tilesetImageBase64, "base64");
  const metadata = Buffer.from(artifact.tilesetMetadataBase64, "base64");
  const url = new URL("/?mode=generated-tilemap", baseURL ?? "http://127.0.0.1:4175").toString();

  const referenceErrors: string[] = [];
  page.on("pageerror", (error) => referenceErrors.push(error.message));
  await page.route("**/fixtures/generated-tilemap.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ...tilemap, properties: tilemap.properties.map((property) => property.name === "tilesetAssetId"
      ? { ...property, value: "00000000-0000-4000-8000-000000000999" }
      : property) }),
  }));
  await page.route("**/fixtures/generated-map-tileset.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: image }));
  await page.route("**/fixtures/generated-map-tileset.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: metadata }));
  await page.goto(url);
  await expect.poll(() => referenceErrors.at(-1), { timeout: 5_000 }).toBe("generated_tilemap_tileset_reference_invalid");

  const missingImagePage = await page.context().newPage();
  const imageErrors: string[] = [];
  missingImagePage.on("pageerror", (error) => imageErrors.push(error.message));
  await missingImagePage.route("**/fixtures/generated-tilemap.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: Buffer.from(artifact.tilemapBase64, "base64"),
  }));
  await missingImagePage.route("**/fixtures/generated-map-tileset.png", (route) => route.fulfill({ status: 404, body: "missing" }));
  await missingImagePage.route("**/fixtures/generated-map-tileset.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: metadata }));
  await missingImagePage.goto(url);
  await expect.poll(() => imageErrors.at(-1), { timeout: 5_000 }).toBe("generated_tilemap_image_missing");
  await missingImagePage.close();
});
