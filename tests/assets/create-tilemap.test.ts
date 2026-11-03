import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  CreateTilemapInputSchema,
  CreateTilesetMetadataSchema,
  type CreateTilesetManifest,
} from "@meta-game/contracts";
import { identityFromAuthenticatedSession, OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import { createCreateTilemapTool, GENERATED_TILEMAP_MANIFEST_PATH } from "../../apps/worker/src/assets/create-tilemap";

const ownerId = "user_tilemapOwnerUnit001";
const projectId = "00000000-0000-4000-8000-000000000331";
const tilesetAssetId = "00000000-0000-4000-8000-000000000332";
const metadataAssetId = "00000000-0000-4000-8000-000000000333";
const identity = identityFromAuthenticatedSession({ userId: ownerId });

describe("create_tilemap", () => {
  it("translates sparse cells into row-major Tiled GIDs, preserving layer order and collision metadata", async () => {
    const harness = await createHarness();
    const tool = createCreateTilemapTool(harness.dependencies);
    const result = await tool(input(), context("map-row-major"));
    const map = JSON.parse(String(harness.files.get(`public/${result.path}`))) as {
      width: number; height: number; tilewidth: number; tileheight: number;
      layers: Array<{ name: string; visible: boolean; data: number[]; properties: Array<{ name: string; value: unknown }> }>;
      tilesets: Array<{ firstgid: number; tiles: Array<{ id: number; properties: Array<{ name: string; value: unknown }> }> }>;
    };

    expect(result).toMatchObject({
      tilesetAssetId,
      width: 4,
      height: 3,
      tileSize: 16,
      layerNames: ["background", "ground"],
      cellCount: 4,
      collisionTileNames: ["ground", "wall"],
      phaserFormat: "phaser-3-tilemap-json",
    });
    expect(map).toMatchObject({ width: 4, height: 3, tilewidth: 16, tileheight: 16 });
    expect(map.layers.map(({ name }) => name)).toEqual(["background", "ground"]);
    expect(map.layers[0]?.visible).toBe(false);
    expect(map.layers[0]?.data).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(map.layers[1]?.data).toEqual([0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 4, 3]);
    expect(map.layers[0]?.properties).toEqual([{ name: "collides", type: "bool", value: false }]);
    expect(map.layers[1]?.properties).toEqual([{ name: "collides", type: "bool", value: true }]);
    expect(map.tilesets[0]).toMatchObject({ firstgid: 1 });
    expect(map.tilesets[0]?.tiles.map(({ id }) => id)).toEqual([0, 1, 2, 3]);
    expect(map.tilesets[0]?.tiles[1]?.properties).toContainEqual({ name: "collides", type: "bool", value: true });
    expect(map.tilesets[0]?.tiles[1]?.properties).toContainEqual({ name: "terrain", type: "string", value: "ground" });
    expect(harness.uploads).toBe(1);
    expect(harness.files.has(GENERATED_TILEMAP_MANIFEST_PATH)).toBe(true);
  });

  it("produces the same ID and hash on retry without adding duplicate metadata", async () => {
    const harness = await createHarness();
    const tool = createCreateTilemapTool(harness.dependencies);
    const call = context("map-idempotent");
    const first = await tool(input(), call);
    const second = await tool(input(), call);
    const manifest = JSON.parse(String(harness.files.get(GENERATED_TILEMAP_MANIFEST_PATH))) as { tilemaps: unknown[] };
    expect(second).toEqual(first);
    expect(manifest.tilemaps).toHaveLength(1);
    expect(harness.uploads).toBe(1);
    expect(harness.files.get(`public/${first.path}`)).toBe(harness.assets.get(first.tilemapAssetId)?.body.toString("utf8"));
  });

  it("accepts the 128×128 edge and keeps the last row-major cell in bounds", async () => {
    const harness = await createHarness();
    const request = {
      name: "edge_map",
      tilesetAssetId,
      width: 128,
      height: 128,
      layers: [{ name: "ground", cells: [{ x: 127, y: 127, tileName: "water" }] }],
      collisionLayerNames: [],
    };
    const result = await createCreateTilemapTool(harness.dependencies)(request, context("map-edge"));
    const map = JSON.parse(String(harness.files.get(`public/${result.path}`))) as { width: number; height: number; layers: Array<{ data: number[] }> };
    expect(result).toMatchObject({ width: 128, height: 128, cellCount: 1, collisionTileNames: [] });
    expect(map.layers[0]?.data).toHaveLength(16_384);
    expect(map.layers[0]?.data[16_383]).toBe(1);
  });

  it.each([
    ["coordinate outside map bounds", { ...input(), layers: [{ name: "ground", cells: [{ x: 4, y: 0, tileName: "water" }] }] }],
    ["duplicate coordinates", { ...input(), layers: [{ name: "ground", cells: [{ x: 1, y: 1, tileName: "water" }, { x: 1, y: 1, tileName: "wall" }] }] }],
    ["duplicate layer names", { ...input(), layers: [{ name: "ground", cells: [] }, { name: "ground", cells: [] }] }],
    ["unknown collision layer", { ...input(), collisionLayerNames: ["missing"] }],
  ])("rejects %s before writing", async (_label, raw) => {
    const harness = await createHarness();
    const parsed = CreateTilemapInputSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    await expect(createCreateTilemapTool(harness.dependencies)(raw as Record<string, unknown>, context("map-invalid")))
      .rejects.toThrow("agent_invalid_tool_arguments");
    expect(harness.uploads).toBe(0);
    expect(harness.files.has(GENERATED_TILEMAP_MANIFEST_PATH)).toBe(false);
  });

  it("rejects unknown tiles and a foreign owner before output writes", async () => {
    const harness = await createHarness();
    const tool = createCreateTilemapTool(harness.dependencies);
    await expect(tool({ ...input(), layers: [{ name: "ground", cells: [{ x: 0, y: 0, tileName: "lava" }] }] }, context("map-unknown-tile")))
      .rejects.toMatchObject({ code: "tilemap_tile_unknown" });
    expect(harness.uploads).toBe(0);

    const otherIdentity = identityFromAuthenticatedSession({ userId: "user_tilemapOtherUnit001" });
    const foreignTool = createCreateTilemapTool({ ...harness.dependencies, identity: async () => otherIdentity });
    await expect(foreignTool(input(), {
      ...context("map-foreign-owner"),
      projectId: "00000000-0000-4000-8000-000000000334",
      claim: { ...context("map-foreign-owner").claim, projectId: "00000000-0000-4000-8000-000000000334", ownerUserId: otherIdentity.userId },
    })).rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    expect(harness.uploads).toBe(0);
  });

  it("compensates a partial manifest write and permits recovery with the same call ID", async () => {
    const harness = await createHarness({ failManifestWriteOnce: true });
    const tool = createCreateTilemapTool(harness.dependencies);
    const call = context("map-recover");
    await expect(tool(input(), call)).rejects.toMatchObject({ code: "tilemap_manifest_write_failed" });
    expect(harness.files.has(`public/assets/generated/tilemaps/${deterministicId(call.claim.runId, call.callId)}.json`)).toBe(false);
    expect(harness.files.has(GENERATED_TILEMAP_MANIFEST_PATH)).toBe(false);
    expect(harness.assets.has(deterministicId(call.claim.runId, call.callId))).toBe(false);
    const recovered = await tool(input(), call);
    expect(recovered.tilemapAssetId).toBe(deterministicId(call.claim.runId, call.callId));
  });

  it("cancels after private upload, removes new state and allows a durable retry", async () => {
    const abort = new AbortController();
    const harness = await createHarness({ abortAfterUpload: () => abort.abort() });
    const tool = createCreateTilemapTool(harness.dependencies);
    const call = context("map-cancel");
    await expect(tool(input(), { ...call, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.assets.has(deterministicId(call.claim.runId, call.callId))).toBe(false);
    expect(harness.files.has(GENERATED_TILEMAP_MANIFEST_PATH)).toBe(false);
    const result = await tool(input(), call);
    expect(result.tilemapAssetId).toBe(deterministicId(call.claim.runId, call.callId));
  });

  it("rejects corrupt tileset hashes and metadata before creating a map", async () => {
    const harness = await createHarness();
    const image = harness.assets.get(tilesetAssetId)!;
    image.body = Buffer.from("corrupt");
    await expect(createCreateTilemapTool(harness.dependencies)(input(), context("map-corrupt")))
      .rejects.toMatchObject({ code: "tileset_image_integrity_invalid" });
    expect(harness.uploads).toBe(0);
    expect(harness.files.has(GENERATED_TILEMAP_MANIFEST_PATH)).toBe(false);
  });
});

function input() {
  return {
    name: "acceptance_level",
    tilesetAssetId,
    width: 4,
    height: 3,
    collisionLayerNames: ["ground"],
    layers: [
      { name: "background", visible: false, cells: [{ x: 1, y: 0, tileName: "water" }] },
      { name: "ground", cells: [{ x: 1, y: 1, tileName: "ground" }, { x: 3, y: 2, tileName: "wall" }, { x: 2, y: 2, tileName: "decoration" }] },
    ],
  };
}

function context(callId: string) {
  const claim: RunWorkerClaim = { runId: "00000000-0000-4000-8000-000000000335", ownerUserId: ownerId, projectId, fencingToken: 1 };
  return { claim, callId, projectId, signal: new AbortController().signal };
}

async function createHarness(options: { failManifestWriteOnce?: boolean; abortAfterUpload?: () => void } = {}) {
  const tileSize = 16;
  const imageBytes = await sharp({ create: { width: 64, height: 16, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).png().toBuffer();
  const imageSha = sha256(imageBytes);
  const metadata = CreateTilesetMetadataSchema.parse({
    schemaVersion: 1,
    engine: "phaser-3.90.0",
    tilesetAssetId,
    name: "acceptance_terrain",
    image: `${tilesetAssetId}.png`,
    imagePath: `assets/generated/tilesets/${tilesetAssetId}.png`,
    metadataPath: `assets/generated/tilesets/${tilesetAssetId}.json`,
    sha256: imageSha,
    tileSize,
    tilewidth: tileSize,
    tileheight: tileSize,
    columns: 4,
    rows: 1,
    tilecount: 4,
    margin: 0,
    spacing: 0,
    width: 64,
    height: 16,
    layout: "input-order-row-major",
    tiles: [
      { id: 0, type: "water", tileIndex: 0, tileName: "water", collides: false, terrain: "water" },
      { id: 1, type: "ground", tileIndex: 1, tileName: "ground", collides: true, terrain: "ground" },
      { id: 2, type: "wall", tileIndex: 2, tileName: "wall", collides: true, terrain: "wall" },
      { id: 3, type: "decoration", tileIndex: 3, tileName: "decoration", collides: false, terrain: "decoration" },
    ],
  });
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const files = new Map<string, string | Uint8Array>([
    ["public/assets/generated/tilesets/manifest.json", JSON.stringify({
      schemaVersion: 1,
      tilesets: [{ tilesetAssetId, name: metadata.name, imagePath: metadata.imagePath, metadataPath: metadata.metadataPath, sha256: imageSha, tileSize, columns: 4, rows: 1, tileCount: 4 }],
    } satisfies CreateTilesetManifest)],
    [`public/${metadata.imagePath}`, imageBytes],
    [`public/${metadata.metadataPath}`, metadataBytes.toString("utf8")],
  ]);
  const assets = new Map<string, { id: string; projectId: string; contentType: string; sizeBytes: number; sha256: string; status: "ready"; metadata: Record<string, unknown>; body: Buffer }>();
  assets.set(tilesetAssetId, {
    id: tilesetAssetId, projectId, contentType: "image/png", sizeBytes: imageBytes.byteLength, sha256: imageSha, status: "ready",
    metadata: { schemaVersion: 1, assetType: "tileset-image", tilesetAssetId, metadataAssetId, name: metadata.name, sha256: imageSha, imagePath: metadata.imagePath, metadataPath: metadata.metadataPath, tileCount: 4 },
    body: Buffer.from(imageBytes),
  });
  assets.set(metadataAssetId, {
    id: metadataAssetId, projectId, contentType: "application/json", sizeBytes: metadataBytes.byteLength, sha256: sha256(metadataBytes), status: "ready",
    metadata: { schemaVersion: 1, assetType: "tileset-metadata", tilesetAssetId, metadataAssetId, sha256: sha256(metadataBytes), imageSha256: imageSha, metadataPath: metadata.metadataPath },
    body: metadataBytes,
  });
  let uploads = 0;
  let failManifestWrite = options.failManifestWriteOnce ?? false;
  const sandbox = {
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
    async writeFile(_project: string, path: string, content: string) {
      files.set(path, content);
      if (path === GENERATED_TILEMAP_MANIFEST_PATH && failManifestWrite) {
        failManifestWrite = false;
        throw new Error("partial_manifest_write");
      }
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    },
    async deleteFile(_project: string, path: string) { return { path, deleted: files.delete(path) }; },
  };
  const storage = {
    async read(_identity: VerifiedIdentityContext, id: string) {
      const asset = assets.get(id);
      if (!asset) throw new OwnedResourceNotFoundError();
      return { asset, body: asset.body };
    },
    async upload(_identity: VerifiedIdentityContext, request: { assetId?: string; projectId: string; contentType: "image/png" | "application/json"; body: Uint8Array; metadata: Record<string, unknown> }) {
      const body = Buffer.from(request.body);
      const id = request.assetId ?? randomUUID();
      const sha = sha256(body);
      const created = !assets.has(id);
      if (created) {
        uploads += 1;
        assets.set(id, { id, projectId: request.projectId, contentType: request.contentType, sizeBytes: body.byteLength, sha256: sha, status: "ready", metadata: request.metadata, body });
      }
      options.abortAfterUpload?.();
      return { id, sha256: sha, status: "ready" as const, created };
    },
    async delete(_identity: VerifiedIdentityContext, id: string) { assets.delete(id); },
  };
  return {
    dependencies: { storage, sandbox, identity: async () => identity },
    files,
    assets,
    get uploads() { return uploads; },
  };
}

function deterministicId(runId: string, callId: string): string {
  const bytes = createHash("sha256").update(`${runId}\0${callId}\0tilemap-json`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
