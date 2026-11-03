import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { identityFromAuthenticatedSession, OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import { createCreateTilesetTool } from "../../apps/worker/src/assets/create-tileset";

const ownerId = "user_tilesetUnitOwner001";
const projectId = "b61e9ef0-2949-41c9-bb01-0055e0000001";
const sourceAssetId = "b61e9ef0-2949-41c9-bb01-0055e0000002";
const claim: RunWorkerClaim = { runId: "b61e9ef0-2949-41c9-bb01-0055e0000003", ownerUserId: ownerId, projectId, fencingToken: 1 };
const identity = identityFromAuthenticatedSession({ userId: ownerId });

describe("create_tileset", () => {
  it.each([
    { count: 1, columns: 1, rows: 1 },
    { count: 16, columns: 4, rows: 4 },
    { count: 256, columns: 16, rows: 16 },
  ])("packs $count validated source frames into the exact row-major grid", async ({ count, columns, rows }) => {
    const harness = await createHarness();
    const tool = createCreateTilesetTool(harness.dependencies);
    const input = inputFor(count, columns);
    const result = await tool(input, context("call-grid"));
    const storedImage = harness.objects.get(result.tilesetAssetId);
    const metadataAssetId = String(storedImage?.metadata.metadataAssetId);
    const storedMetadata = harness.objects.get(metadataAssetId);
    const decoded = await sharp(storedImage!.body).raw().toBuffer({ resolveWithObject: true });

    expect(result).toMatchObject({ tileSize: 8, columns, rows });
    expect(result.tiles).toHaveLength(count);
    expect(result.tiles.map(({ tileIndex }) => tileIndex)).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(decoded.info).toMatchObject({ width: columns * 8, height: rows * 8, channels: 4 });
    expect(result.sha256).toBe(sha256(storedImage!.body));
    expect(harness.objects.size).toBe(3);
    expect(JSON.parse(storedMetadata!.body.toString("utf8"))).toMatchObject({
      schemaVersion: 1,
      engine: "phaser-3.90.0",
      layout: "input-order-row-major",
      tilewidth: 8,
      tileheight: 8,
      tilecount: count,
      image: `${result.tilesetAssetId}.png`,
      width: columns * 8,
      height: rows * 8,
    });
    expect(JSON.parse(String(harness.files.get("public/assets/generated/tilesets/manifest.json"))).tilesets).toHaveLength(1);
  });

  it("preserves supplied order, alpha, collision and terrain while output bytes are deterministic", async () => {
    const first = await createHarness();
    const second = await createHarness();
    const request = {
      name: "forest_tiles",
      tileSize: 8,
      columns: 2,
      tiles: [
        { sourceAssetId, sourceFrameIndex: 7, tileName: "water", terrain: "water" as const },
        { sourceAssetId, sourceFrameIndex: 0, tileName: "ground", collides: true, terrain: "ground" as const },
        { sourceAssetId, sourceFrameIndex: 2, tileName: "wall", collides: true, terrain: "wall" as const },
      ],
    };
    const a = await createCreateTilesetTool(first.dependencies)(request, context("call-order-a"));
    const b = await createCreateTilesetTool(second.dependencies)(request, context("call-order-b"));
    const stored = first.objects.get(a.tilesetAssetId)!;
    const pixels = await sharp(stored.body).raw().toBuffer({ resolveWithObject: true });
    expect(a.sha256).toBe(b.sha256);
    expect(a.tiles.map(({ tileName }) => tileName)).toEqual(["water", "ground", "wall"]);
    expect(a.tiles).toMatchObject([
      { tileIndex: 0, tileName: "water", collides: false, terrain: "water" },
      { tileIndex: 1, tileName: "ground", collides: true, terrain: "ground" },
      { tileIndex: 2, tileName: "wall", collides: true, terrain: "wall" },
    ]);
    const raw = pixels.data;
    const tile0 = raw.subarray(0, 4);
    const tile1 = raw.subarray(8 * 4, 8 * 4 + 4);
    const tile2 = raw.subarray(8 * 16 * 4, 8 * 16 * 4 + 4);
    expect([...tile0]).toEqual([7, 180, 90, 0]);
    expect([...tile1]).toEqual([0, 180, 90, 0]);
    expect([...tile2]).toEqual([2, 180, 90, 0]);
  });

  it("retries the same run call with the same IDs and does not duplicate storage or manifest entries", async () => {
    const harness = await createHarness();
    const tool = createCreateTilesetTool(harness.dependencies);
    const request = inputFor(4, 2);
    const first = await tool(request, context("call-idempotent"));
    const replay = await tool(request, context("call-idempotent"));

    expect(replay).toEqual(first);
    expect(harness.objects.size).toBe(3);
    expect(JSON.parse(String(harness.files.get("public/assets/generated/tilesets/manifest.json"))).tilesets).toHaveLength(1);
  });

  it("rejects duplicate names and mismatched/non-square frames before writing", async () => {
    const harness = await createHarness();
    const tool = createCreateTilesetTool(harness.dependencies);
    await expect(tool({ ...inputFor(2, 2), tiles: [
      { sourceAssetId, tileName: "ground" },
      { sourceAssetId, tileName: "ground" },
    ] }, context("call-duplicate"))).rejects.toThrow("agent_invalid_tool_arguments");
    const nonSquare = await createHarness({ frameWidth: 8, frameHeight: 16 });
    await expect(createCreateTilesetTool(nonSquare.dependencies)(inputFor(1, 1), context("call-size")))
      .rejects.toMatchObject({ code: "tileset_source_size_mismatch" });
    expect(nonSquare.objects.size).toBe(1);
    expect(nonSquare.files.has("public/assets/generated/tilesets/manifest.json")).toBe(false);
  });

  it("hides a different owner's source and rejects an out-of-range source frame", async () => {
    const foreign = await createHarness({ foreignSource: true });
    await expect(createCreateTilesetTool(foreign.dependencies)(inputFor(1, 1), context("call-foreign")))
      .rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    const normal = await createHarness({ frameColumns: 4, frameRows: 4 });
    await expect(createCreateTilesetTool(normal.dependencies)({
      ...inputFor(1, 1), tiles: [{ sourceAssetId, sourceFrameIndex: 16, tileName: "ground" }],
    }, context("call-frame"))).rejects.toMatchObject({ code: "tileset_source_frame_out_of_range" });
    expect(normal.objects.size).toBe(1);
  });

  it("compensates storage and workspace writes when either metadata or manifest persistence fails", async () => {
    const storageFailure = await createHarness({ failUploadAt: 2 });
    await expect(createCreateTilesetTool(storageFailure.dependencies)(inputFor(2, 2), context("call-storage-fail")))
      .rejects.toThrow("fixture_storage_write_failed");
    expect(storageFailure.objects.size).toBe(1);
    expect(storageFailure.files.has("public/assets/generated/tilesets/manifest.json")).toBe(false);

    const manifestFailure = await createHarness({ failWritePath: "public/assets/generated/tilesets/manifest.json" });
    await expect(createCreateTilesetTool(manifestFailure.dependencies)(inputFor(2, 2), context("call-manifest-fail")))
      .rejects.toMatchObject({ code: "tileset_workspace_manifest_write_failed" });
    expect(manifestFailure.objects.size).toBe(1);
    expect([...manifestFailure.files.keys()].some((path) => path.includes("/tilesets/") && !path.endsWith("manifest.json"))).toBe(false);
    expect(manifestFailure.files.has("public/assets/generated/tilesets/manifest.json")).toBe(false);
  });
});

function inputFor(count: number, columns: number) {
  return {
    name: `tileset_${count}`,
    tileSize: 8,
    columns,
    tiles: Array.from({ length: count }, (_, index) => ({ sourceAssetId, sourceFrameIndex: index % 64, tileName: `tile-${index}`, collides: index % 2 === 0, terrain: "ground" as const })),
  };
}

function context(callId: string) {
  return { claim, callId, projectId, signal: new AbortController().signal };
}

async function createHarness(options: { frameWidth?: number; frameHeight?: number; frameColumns?: number; frameRows?: number; foreignSource?: boolean; failUploadAt?: number; failWritePath?: string } = {}) {
  const frameWidth = options.frameWidth ?? 8;
  const frameHeight = options.frameHeight ?? 8;
  const frameColumns = options.frameColumns ?? 8;
  const frameRows = options.frameRows ?? 8;
  const raw = Buffer.alloc(frameColumns * frameWidth * frameRows * frameHeight * 4);
  for (let index = 0; index < frameColumns * frameRows; index += 1) {
    for (let y = 0; y < frameHeight; y += 1) {
      for (let x = 0; x < frameWidth; x += 1) {
        const offset = ((Math.floor(index / frameColumns) * frameHeight + y) * (frameColumns * frameWidth) + (index % frameColumns) * frameWidth + x) * 4;
        raw[offset] = index;
        raw[offset + 1] = 180;
        raw[offset + 2] = 90;
        raw[offset + 3] = index < 8 ? 0 : 255;
      }
    }
  }
  const sourceBytes = await sharp(raw, { raw: { width: frameColumns * frameWidth, height: frameRows * frameHeight, channels: 4 } }).png().toBuffer();
  const sourceSha256 = sha256(sourceBytes);
  const metadata = {
    schemaVersion: 1,
    source: "meta-model-api",
    assetType: "sprite",
    model: "muse-image-1.0",
    prompt: "Synthetic local fixture.",
    createdAt: "2026-11-03T00:00:00.000Z",
    responseId: "fixture-response-tileset",
    originalMimeType: "image/png",
    mimeType: "image/png",
    originalSha256: sourceSha256,
    sha256: sourceSha256,
    width: frameColumns * frameWidth,
    height: frameRows * frameHeight,
    hasAlpha: true,
    transparentPixels: true,
    requestedTransparency: true,
    frames: { columns: frameColumns, rows: frameRows, frameWidth, frameHeight },
    edits: ["png-reencoded"],
    qa: { contactSheetAssetId: "b61e9ef0-2949-41c9-bb01-0055e0000004", contactSheetSha256: "a".repeat(64), visualReview: "pending-in-live-preview" },
  };
  const objects = new Map<string, { id: string; projectId: string; contentType: string; sizeBytes: number; sha256: string; metadata: Record<string, unknown>; body: Buffer; status: "ready" }>();
  objects.set(sourceAssetId, {
    id: sourceAssetId,
    projectId,
    contentType: "image/png",
    sizeBytes: sourceBytes.byteLength,
    sha256: sourceSha256,
    metadata,
    body: sourceBytes,
    status: "ready",
  });
  const files = new Map<string, string | Uint8Array>([["public/assets/generated/manifest.json", JSON.stringify({
    schemaVersion: 1,
    assets: [{ assetId: sourceAssetId, key: `generated-${sourceAssetId}`, path: `assets/generated/${sourceAssetId}.png`, assetType: "sprite", frameColumns, frameRows, frameWidth, frameHeight }],
  })]]);
  let uploads = 0;
  let writeCount = 0;
  const storage = {
    async read(_provided: VerifiedIdentityContext, assetId: string) {
      const found = objects.get(assetId);
      if (!found || options.foreignSource && assetId === sourceAssetId) throw new OwnedResourceNotFoundError();
      return { asset: found, body: found.body };
    },
    async upload(_provided: VerifiedIdentityContext, request: { assetId?: string; projectId: string; contentType: "image/png" | "application/json"; body: Uint8Array; metadata: Record<string, unknown> }) {
      uploads += 1;
      if (options.failUploadAt === uploads) throw new Error("fixture_storage_write_failed");
      const id = request.assetId ?? randomUUID();
      const body = Buffer.from(request.body);
      const checksum = sha256(body);
      const existing = objects.get(id);
      if (existing) {
        if (existing.sha256 !== checksum || JSON.stringify(existing.metadata) !== JSON.stringify(request.metadata)) throw new Error("fixture_idempotency_conflict");
        return { id, sha256: checksum, status: "ready" as const, created: false };
      }
      objects.set(id, { id, projectId: request.projectId, contentType: request.contentType, sizeBytes: body.byteLength, sha256: checksum, metadata: request.metadata, body, status: "ready" });
      return { id, sha256: checksum, status: "ready" as const, created: true };
    },
    async delete(_provided: VerifiedIdentityContext, id: string) { objects.delete(id); },
  };
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
    async writeBinaryFile(_project: string, path: string, body: Uint8Array) {
      files.set(path, Buffer.from(body));
      writeCount += 1;
      return { path, bytesWritten: body.byteLength };
    },
    async writeFile(_project: string, path: string, body: string) {
      files.set(path, body);
      writeCount += 1;
      if (options.failWritePath === path) throw new Error("fixture_workspace_write_failed");
      return { path, bytesWritten: Buffer.byteLength(body, "utf8") };
    },
    async deleteFile(_project: string, path: string) {
      return { path, deleted: files.delete(path) };
    },
  };
  return {
    dependencies: { storage, sandbox, identity: async () => identity },
    objects,
    files,
    get writeCount() { return writeCount; },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
