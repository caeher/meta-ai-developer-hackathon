import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseFromEnvironment,
  createRepositories,
  identityFromAuthenticatedSession,
  OwnedResourceNotFoundError,
  users,
  type RunWorkerClaim,
} from "@meta-game/db";
import { createPrivateStorageFromEnvironment } from "@meta-game/storage";
import { createCreateTilesetTool } from "../../apps/worker/src/assets/create-tileset";
import { createCreateTilemapTool } from "../../apps/worker/src/assets/create-tilemap";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";

describe.skipIf(!integrationEnabled)("create_tilemap con PostgreSQL, Silo, Phaser metadata y ownership", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const ownerA = `user_tilemapOwnerA${suffix}`;
  const ownerB = `user_tilemapOwnerB${suffix}`;
  const identityA = identityFromAuthenticatedSession({ userId: ownerA });
  const identityB = identityFromAuthenticatedSession({ userId: ownerB });
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;
  let storage: ReturnType<typeof createPrivateStorageFromEnvironment>;
  let projectA: string;
  let projectB: string;
  let sourceAssetId: string;
  let tilesetAssetId: string;
  let claimA: RunWorkerClaim;
  const created: Array<{ identity: typeof identityA; id: string }> = [];

  beforeAll(async () => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
    storage = createPrivateStorageFromEnvironment(repositories.assets);
    const [forA, forB] = await Promise.all([
      repositories.projects.create(identityA, { name: "Tilemap acceptance owner A" }),
      repositories.projects.create(identityB, { name: "Tilemap acceptance owner B" }),
    ]);
    projectA = forA.id;
    projectB = forB.id;
    claimA = { runId: randomUUID(), ownerUserId: ownerA, projectId: projectA, fencingToken: 1 };
    const sourceBytes = await makeSourceStrip();
    const sourceSha = sha256(sourceBytes);
    const source = await storage.upload(identityA, {
      projectId: projectA,
      contentType: "image/png",
      body: sourceBytes,
      metadata: sourceMetadata(sourceSha),
    });
    sourceAssetId = source.id;
    created.push({ identity: identityA, id: source.id });
  });

  afterAll(async () => {
    if (storage) {
      for (const item of created.reverse()) await storage.delete(item.identity, item.id).catch(() => undefined);
      storage.close();
    }
    if (database) {
      await database.db.delete(users).where(inArray(users.userId, [ownerA, ownerB]));
      await database.close();
    }
  });

  it("writes a deterministic Phaser JSON tilemap to Silo and to the private workspace", async () => {
    const sandbox = makeSandbox(projectA, sourceAssetId);
    const tilemapContext = {
      claim: claimA,
      callId: "create-tilemap-acceptance",
      projectId: projectA,
      signal: new AbortController().signal,
    };
    const tileset = await createCreateTilesetTool({ storage, sandbox, identity: async () => identityA })(tilesetInput(sourceAssetId), {
      ...tilemapContext,
      callId: "create-tileset-for-tilemap-acceptance",
    });
    tilesetAssetId = tileset.tilesetAssetId;
    const storedTileset = await storage.read(identityA, tilesetAssetId);
    const storedTilesetMetadataAsset = await storage.read(identityA, String(storedTileset.asset.metadata?.metadataAssetId));
    created.push({ identity: identityA, id: tilesetAssetId }, { identity: identityA, id: storedTilesetMetadataAsset.asset.id });
    const tool = createCreateTilemapTool({ storage, sandbox, identity: async () => identityA });
    const request = tilemapInput(tilesetAssetId);
    const first = await tool(request, tilemapContext);
    const storedMap = await storage.read(identityA, first.tilemapAssetId);
    created.push({ identity: identityA, id: first.tilemapAssetId });

    const mapJson = JSON.parse(Buffer.from(storedMap.body).toString("utf8")) as {
      width: number; height: number; tilewidth: number; tileheight: number;
      layers: Array<{ name: string; visible: boolean; data: number[]; properties: Array<{ name: string; value: unknown }> }>;
      tilesets: Array<{ firstgid: number; image: string; tiles: Array<{ id: number; properties: Array<{ name: string; value: unknown }> }> }>;
    };
    expect(first).toMatchObject({
      tilesetAssetId,
      width: 8,
      height: 6,
      tileSize: 16,
      layerNames: ["background", "hidden", "ground", "props"],
      cellCount: 12,
      collisionTileNames: ["ground"],
      phaserFormat: "phaser-3-tilemap-json",
    });
    expect(storedMap.asset.projectId).toBe(projectA);
    expect(storedMap.asset.sha256).toBe(first.sha256);
    expect(hash(storedMap.body)).toBe(first.sha256);
    expect(Buffer.from(storedMap.body)).toEqual(Buffer.from(sandbox.files.get(`public/${first.path}`) as string));
    expect(mapJson).toMatchObject({ width: 8, height: 6, tilewidth: 16, tileheight: 16 });
    expect(mapJson.layers.map(({ name }) => name)).toEqual(first.layerNames);
    expect(mapJson.layers[1]?.visible).toBe(false);
    expect(mapJson.layers[0]?.data.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(mapJson.layers[2]?.data.slice(32, 38)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(mapJson.layers[2]?.properties).toContainEqual({ name: "collides", type: "bool", value: true });
    expect(mapJson.layers[3]?.properties).toContainEqual({ name: "collides", type: "bool", value: false });
    expect(mapJson.tilesets[0]?.firstgid).toBe(1);
    expect(mapJson.tilesets[0]?.image).toBe(`../tilesets/${tilesetAssetId}.png`);
    expect(mapJson.tilesets[0]?.tiles.map(({ id }) => id)).toEqual([0, 1, 2, 3]);
    expect(mapJson.tilesets[0]?.tiles[1]?.properties).toContainEqual({ name: "collides", type: "bool", value: true });
    expect(Buffer.from(storedTilesetMetadataAsset.body).toString("utf8")).toBe(String(sandbox.files.get(`public/${tileset.metadataPath}`)));

    const retry = await tool(request, tilemapContext);
    expect(retry).toEqual(first);
    expect(JSON.parse(String(sandbox.files.get("public/assets/generated/tilemaps/manifest.json"))).tilemaps).toHaveLength(1);

    const artifactPath = process.env.ISSUE_33_TILEMAP_PREVIEW_ARTIFACT;
    if (artifactPath) {
      await writeFile(artifactPath, JSON.stringify({
        result: first,
        tilemapBase64: Buffer.from(storedMap.body).toString("base64"),
        tilesetImageBase64: Buffer.from(storedTileset.body).toString("base64"),
        tilesetMetadataBase64: Buffer.from(storedTilesetMetadataAsset.body).toString("base64"),
      }), { encoding: "utf8", flag: "wx" });
    }
  });

  it("rejects a tileset owned by a different user before persisting map data", async () => {
    const foreignSandbox = makeSandbox(projectB, sourceAssetId);
    const storedTileset = await storage.read(identityA, tilesetAssetId);
    const metadataAsset = await storage.read(identityA, String(storedTileset.asset.metadata?.metadataAssetId));
    const metadata = JSON.parse(Buffer.from(metadataAsset.body).toString("utf8")) as {
      name: string; imagePath: string; metadataPath: string; sha256: string; tileSize: number; columns: number; rows: number; tilecount: number;
    };
    foreignSandbox.files.set("public/assets/generated/tilesets/manifest.json", JSON.stringify({
      schemaVersion: 1,
      tilesets: [{ tilesetAssetId, name: metadata.name, imagePath: metadata.imagePath, metadataPath: metadata.metadataPath, sha256: metadata.sha256, tileSize: metadata.tileSize, columns: metadata.columns, rows: metadata.rows, tileCount: metadata.tilecount }],
    }));
    foreignSandbox.files.set(`public/${metadata.imagePath}`, Buffer.from(storedTileset.body));
    foreignSandbox.files.set(`public/${metadata.metadataPath}`, Buffer.from(metadataAsset.body).toString("utf8"));
    const foreignClaim: RunWorkerClaim = { runId: randomUUID(), ownerUserId: ownerB, projectId: projectB, fencingToken: 1 };
    const tool = createCreateTilemapTool({ storage, sandbox: foreignSandbox, identity: async () => identityB });
    await expect(tool(tilemapInput(tilesetAssetId), {
      claim: foreignClaim,
      callId: "foreign-tilemap-tileset",
      projectId: projectB,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    expect(foreignSandbox.files.has("public/assets/generated/tilemaps/manifest.json")).toBe(false);
  });
});

function tilesetInput(assetId: string) {
  return {
    name: "acceptance_terrain",
    tileSize: 16,
    columns: 2,
    layout: "input-order-row-major" as const,
    tiles: [
      { sourceAssetId: assetId, sourceFrameIndex: 0, tileName: "water", terrain: "water" as const },
      { sourceAssetId: assetId, sourceFrameIndex: 1, tileName: "ground", collides: true, terrain: "ground" as const },
      { sourceAssetId: assetId, sourceFrameIndex: 2, tileName: "wall", collides: true, terrain: "wall" as const },
      { sourceAssetId: assetId, sourceFrameIndex: 3, tileName: "decoration", terrain: "decoration" as const },
    ],
  };
}

function tilemapInput(tilesetId: string) {
  return {
    name: "acceptance_level",
    tilesetAssetId: tilesetId,
    width: 8,
    height: 6,
    collisionLayerNames: ["ground"],
    layers: [
      { name: "background", cells: [
        { x: 0, y: 0, tileName: "water" }, { x: 1, y: 0, tileName: "ground" },
        { x: 2, y: 0, tileName: "wall" }, { x: 3, y: 0, tileName: "decoration" },
      ] },
      { name: "hidden", visible: false, cells: [{ x: 7, y: 0, tileName: "decoration" }] },
      { name: "ground", cells: Array.from({ length: 6 }, (_, x) => ({ x, y: 4, tileName: "ground" })) },
      { name: "props", cells: [{ x: 7, y: 4, tileName: "wall" }] },
    ],
  };
}

function makeSandbox(_projectId: string, sourceAssetId: string) {
  const files = new Map<string, string | Uint8Array>([["public/assets/generated/manifest.json", JSON.stringify({
    schemaVersion: 1,
    assets: [{ assetId: sourceAssetId, key: `generated-${sourceAssetId}`, path: `assets/generated/${sourceAssetId}.png`, assetType: "tileset", frameColumns: 4, frameRows: 1, frameWidth: 16, frameHeight: 16 }],
  })]]);
  return {
    files,
    async readFile(_project: string, path: string) {
      const value = files.get(path);
      if (typeof value !== "string") throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return { path, content: value };
    },
    async readBinaryFile(_project: string, path: string) {
      const value = files.get(path);
      if (!(value instanceof Uint8Array)) throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return value;
    },
    async writeBinaryFile(_project: string, path: string, body: Uint8Array) {
      files.set(path, Buffer.from(body));
      return { path, bytesWritten: body.byteLength };
    },
    async writeFile(_project: string, path: string, body: string) {
      files.set(path, body);
      return { path, bytesWritten: Buffer.byteLength(body, "utf8") };
    },
    async deleteFile(_project: string, path: string) { return { path, deleted: files.delete(path) }; },
  };
}

async function makeSourceStrip(): Promise<Buffer> {
  const colors = [
    { r: 35, g: 115, b: 230 }, { r: 38, g: 220, b: 80 },
    { r: 190, g: 70, b: 225 }, { r: 230, g: 190, b: 35 },
  ];
  const raw = Buffer.alloc(64 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const color = colors[Math.floor(x / 16)]!;
      const offset = (y * 64 + x) * 4;
      raw[offset] = color.r;
      raw[offset + 1] = color.g;
      raw[offset + 2] = color.b;
      raw[offset + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: 64, height: 16, channels: 4 } }).png().toBuffer();
}

function sourceMetadata(checksum: string) {
  return {
    schemaVersion: 1,
    source: "meta-model-api",
    assetType: "tileset",
    model: "muse-image-1.0",
    prompt: "Four original synthetic local terrain tiles for the Phaser tilemap acceptance fixture.",
    createdAt: "2026-11-03T00:00:00.000Z",
    responseId: "fixture-tilemap-source",
    originalMimeType: "image/png",
    mimeType: "image/png",
    originalSha256: checksum,
    sha256: checksum,
    width: 64,
    height: 16,
    hasAlpha: true,
    transparentPixels: false,
    requestedTransparency: false,
    frames: { columns: 4, rows: 1, frameWidth: 16, frameHeight: 16 },
    edits: ["png-reencoded"],
    qa: { contactSheetAssetId: randomUUID(), contactSheetSha256: sha256(Buffer.from("tilemap-fixture")), visualReview: "pending-in-live-preview" },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hash(bytes: Uint8Array): string {
  return sha256(bytes);
}
