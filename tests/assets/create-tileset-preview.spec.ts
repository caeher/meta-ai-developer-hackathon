import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, test } from "playwright/test";

type AcceptanceArtifact = {
  result: {
    tilesetAssetId: string;
    name: string;
    imagePath: string;
    metadataPath: string;
    sha256: string;
    tileSize: number;
    columns: number;
    rows: number;
    tiles: Array<{ id: number; type: string; tileIndex: number; tileName: string; collides: boolean; terrain: string }>;
  };
  imageBase64: string;
  metadataBase64: string;
};

const artifactPath = process.env.ISSUE_32_TILESET_PREVIEW_ARTIFACT;

test("create_tileset output from Compose maps every stable tile ID and renders collisions in Phaser 3.90", async ({ page, baseURL }) => {
  test.skip(!artifactPath, "Run npm run test:assets:acceptance to load the PostgreSQL/Silo artifact.");
  const artifact = JSON.parse(await readFile(artifactPath!, "utf8")) as AcceptanceArtifact;
  const image = Buffer.from(artifact.imageBase64, "base64");
  const metadataBytes = Buffer.from(artifact.metadataBase64, "base64");
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as AcceptanceArtifact["result"] & { engine: string; sha256: string };
  const decoded = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  expect(metadata.engine).toBe("phaser-3.90.0");
  expect(metadata.sha256).toBe(artifact.result.sha256);
  expect(metadata.tiles.map(({ tileIndex }) => tileIndex)).toEqual([0, 1, 2, 3]);
  expect(artifact.result).toMatchObject({ columns: 2, rows: 2, tileSize: 16 });
  expect(decoded.info).toMatchObject({ width: 32, height: 32, channels: 4 });

  await page.route("**/fixtures/generated-tileset.png", (route) => route.fulfill({ status: 200, contentType: "image/png", body: image }));
  await page.route("**/fixtures/generated-tileset.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: metadataBytes }));
  await page.goto(new URL("/?mode=generated-tileset", baseURL ?? "http://127.0.0.1:4175").toString());
  await page.waitForFunction(() => Boolean(window.__ASSET_PREVIEW_TEST__?.().loaded), undefined, { timeout: 10_000 });
  await page.waitForFunction(() => {
    const state = window.__ASSET_PREVIEW_TEST__?.();
    return Boolean(state && state.playerBottom >= 63.5 && state.playerBottom <= 64.5);
  }, undefined, { timeout: 5_000 });
  const state = await page.evaluate(() => window.__ASSET_PREVIEW_TEST__?.());
  expect(state).toMatchObject({
    loaded: true,
    collisionEnabled: true,
    floorTop: 64,
    tileset: {
      name: "acceptance_terrain",
      firstgid: 1,
      localIndexByName: { water: 0, ground: 1, wall: 2, decoration: 3 },
      globalIndexByName: { water: 1, ground: 2, wall: 3, decoration: 4 },
      collisionLocalIndices: [1, 2],
      terrainByLocalIndex: { 0: "water", 1: "ground", 2: "wall", 3: "decoration" },
    },
    tileProperties: { collides: true, terrain: "ground", name: "ground" },
  });
  expect(state?.playerBottom).toBeCloseTo(64, 0);

  const evidenceDirectory = path.resolve(process.cwd(), "docs/evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  const screenshot = await page.locator("canvas").screenshot({ path: path.join(evidenceDirectory, "issue-32-phaser-tileset.png") });
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
});
