import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  PackSpritesheetInputJsonSchema,
  PackSpritesheetInputSchema,
  PackSpritesheetResultJsonSchema,
  PackSpritesheetResultSchema,
} from "@meta-game/contracts";
import { identityFromAuthenticatedSession, OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import { createPackSpritesheetTool, GENERATED_SPRITESHEET_MANIFEST_PATH } from "../../apps/worker/src/assets/pack-spritesheet";
import { parseGeneratedSpritesheetAtlas } from "../../packages/game-templates/phaser/src/game/generated-assets";

const ownerId = "user_spritesheetUnitOwner001";
const otherOwnerId = "user_spritesheetUnitOther001";
const projectId = "00000000-0000-4000-8000-000000000341";
const sourceOneId = "00000000-0000-4000-8000-000000000342";
const sourceTwoId = "00000000-0000-4000-8000-000000000343";
const sourceThreeId = "00000000-0000-4000-8000-000000000344";
const claim: RunWorkerClaim = {
  runId: "00000000-0000-4000-8000-000000000345",
  ownerUserId: ownerId,
  projectId,
  fencingToken: 1,
};
const identity = identityFromAuthenticatedSession({ userId: ownerId });

type FixtureSource = Readonly<{ assetId: string; width: number; height: number; color: readonly [number, number, number, number] }>;
const sources: FixtureSource[] = [
  { assetId: sourceOneId, width: 2, height: 2, color: [21, 72, 140, 255] },
  { assetId: sourceTwoId, width: 3, height: 2, color: [210, 90, 30, 255] },
  { assetId: sourceThreeId, width: 2, height: 1, color: [70, 190, 115, 255] },
];

describe("pack_spritesheet", () => {
  it("exports the issue JSON Schema 2020-12 contract and validates defaults and unique names", () => {
    const parsed = PackSpritesheetInputSchema.parse({ name: "hero_sheets", frames: [
      { sourceAssetId: sourceOneId, frameName: "run_0" },
    ] });
    expect(parsed).toMatchObject({ paddingPixels: 2, extrudePixels: 0, maxTextureSize: 2_048 });
    expect(parsed.frames[0]?.sourceFrameIndex).toBe(0);
    expect(PackSpritesheetInputJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      required: ["name", "frames"],
    });
    expect(PackSpritesheetInputSchema.safeParse({ name: "hero_sheets", frames: [
      { sourceAssetId: sourceOneId, frameName: "run_0" },
      { sourceAssetId: sourceTwoId, frameName: "run_0" },
    ] }).success).toBe(false);
    expect(PackSpritesheetResultJsonSchema.required).toEqual([
      "atlasAssetId", "textureAssetId", "atlasPath", "imagePath", "sha256", "width", "height", "format", "frames",
    ]);
  });

  it("shelf-packs varied frames in input order with pivots, provenance, transparent padding, and exact RGBA crops", async () => {
    const harness = await createHarness();
    const request = input();
    const result = await createPackSpritesheetTool(harness.dependencies)(request, context("call-pack-main"));
    const texture = harness.objects.get(result.textureAssetId)!;
    const atlasObject = harness.objects.get(result.atlasAssetId)!;
    const decoded = await sharp(texture.body).raw().toBuffer({ resolveWithObject: true });
    const atlas = JSON.parse(atlasObject.body.toString("utf8")) as {
      frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; pivot: { x: number; y: number } }>;
      meta: { image: string; size: { w: number; h: number }; provenance: Array<{ frameName: string; sourceAssetId: string; sourceFrameIndex: number; sourceSha256: string }> };
    };
    expect(result).toMatchObject({
      format: "phaser-json-hash",
      imagePath: "assets/generated/atlases/" + result.textureAssetId + ".png",
      atlasPath: "assets/generated/atlases/" + result.atlasAssetId + ".json",
      width: decoded.info.width,
      height: decoded.info.height,
    });
    expect(result.frames.map(({ frameName }) => frameName)).toEqual(["run_0", "run_1", "run_2"]);
    expect(PackSpritesheetResultSchema.safeParse(result).success).toBe(true);
    expect(atlas.meta).toMatchObject({ image: result.textureAssetId + ".png", size: { w: result.width, h: result.height } });
    expect(atlas.meta.provenance).toMatchObject([
      { frameName: "run_0", sourceAssetId: sourceOneId, sourceFrameIndex: 0 },
      { frameName: "run_1", sourceAssetId: sourceTwoId, sourceFrameIndex: 0 },
      { frameName: "run_2", sourceAssetId: sourceThreeId, sourceFrameIndex: 0 },
    ]);
    expect(parseGeneratedSpritesheetAtlas(atlas)).toMatchObject({
      image: result.textureAssetId + ".png",
      width: result.width,
      height: result.height,
      frameNames: ["run_0", "run_1", "run_2"],
    });
    for (const frame of result.frames) {
      const atlasFrame = atlas.frames[frame.frameName]!;
      expect(atlasFrame.frame).toEqual({ x: frame.x, y: frame.y, w: frame.width, h: frame.height });
      expect(atlasFrame.pivot).toEqual({ x: 0.5, y: 1 });
      const expected = await sourcePixels(frame.frameName);
      const actual = crop(decoded.data, decoded.info.width, frame);
      expect(actual).toEqual(expected);
    }
    const first = result.frames[0]!;
    const firstSource = await sourcePixels(first.frameName);
    expect(firstSource.some((value, index) => index % 4 === 3 && value === 0)).toBe(false);
    const rowPaddingY = first.y + first.height + 1;
    if (rowPaddingY < result.height) {
      const paddingOffset = (rowPaddingY * decoded.info.width + first.x) * 4;
      expect([...decoded.data.subarray(paddingOffset, paddingOffset + 4)]).toEqual([0, 0, 0, 0]);
    }
    expect(atlasObject.metadata).toMatchObject({
      schemaVersion: 1,
      engine: "phaser-3.90.0",
      format: "phaser-json-hash",
      atlasSha256: sha256(atlasObject.body),
      frames: [
        { frameName: "run_0", sourceAssetId: sourceOneId, sourceFrameIndex: 0 },
        {},
        {},
      ],
    });
    expect(texture.metadata.sha256).toBe(result.sha256);
    expect(harness.files.has("public/" + result.imagePath)).toBe(true);
    expect(harness.files.has("public/" + result.atlasPath)).toBe(true);
    expect(JSON.parse(String(harness.files.get(GENERATED_SPRITESHEET_MANIFEST_PATH))).spritesheets).toHaveLength(1);
  });

  it("produces stable layout and texture hashes for the same input across call IDs and replays", async () => {
    const firstHarness = await createHarness();
    const secondHarness = await createHarness();
    const firstTool = createPackSpritesheetTool(firstHarness.dependencies);
    const firstCall = context("call-deterministic-one");
    const first = await firstTool(input(), firstCall);
    expect(await firstTool(input(), firstCall)).toEqual(first);
    const second = await createPackSpritesheetTool(secondHarness.dependencies)(input(), context("call-deterministic-two"));
    expect(first.frames).toEqual(second.frames);
    expect(first.sha256).toBe(second.sha256);
    expect(first.atlasAssetId).not.toBe(second.atlasAssetId);
    expect(firstHarness.objects.size).toBe(sources.length + 2);
    expect(JSON.parse(String(firstHarness.files.get(GENERATED_SPRITESHEET_MANIFEST_PATH))).spritesheets).toHaveLength(1);
  });

  it("supports all 256 frames and rejects duplicate names, unavailable frames, foreign owners, and over-limit layouts before writes", async () => {
    const full = await createHarness({ sources: [{ assetId: sourceOneId, width: 8, height: 8, color: [35, 115, 230, 255] }], grid: { columns: 8, rows: 8 } });
    const frames = Array.from({ length: 256 }, (_, index) => ({
      sourceAssetId: sourceOneId,
      sourceFrameIndex: index % 64,
      frameName: "frame_" + index,
    }));
    const result = await createPackSpritesheetTool(full.dependencies)({
      name: "full_sheet", frames, paddingPixels: 0, maxTextureSize: 512,
    }, context("call-full-256"));
    expect(result.frames).toHaveLength(256);
    expect(result.width).toBeLessThanOrEqual(512);
    expect(result.height).toBeLessThanOrEqual(512);

    const duplicate = await createHarness();
    await expect(createPackSpritesheetTool(duplicate.dependencies)({
      ...input(), frames: [{ sourceAssetId: sourceOneId, frameName: "same" }, { sourceAssetId: sourceTwoId, frameName: "same" }],
    }, context("call-duplicate-name"))).rejects.toThrow("agent_invalid_tool_arguments");
    expect(duplicate.objects.size).toBe(sources.length);

    const missingFrame = await createHarness();
    await expect(createPackSpritesheetTool(missingFrame.dependencies)({
      ...input(), frames: [{ sourceAssetId: sourceOneId, sourceFrameIndex: 1, frameName: "missing" }],
    }, context("call-missing-frame"))).rejects.toMatchObject({ code: "spritesheet_source_frame_out_of_range" });
    expect(missingFrame.objects.size).toBe(sources.length);

    const foreign = await createHarness();
    const foreignIdentity = identityFromAuthenticatedSession({ userId: otherOwnerId });
    const foreignTool = createPackSpritesheetTool({ ...foreign.dependencies, identity: async () => foreignIdentity });
    const foreignClaim = { ...claim, ownerUserId: otherOwnerId };
    await expect(foreignTool(input(), { ...context("call-foreign"), claim: foreignClaim }))
      .rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    expect(foreign.objects.size).toBe(sources.length);

    const oversizedSources: FixtureSource[] = [
      { assetId: sourceOneId, width: 32, height: 64, color: [90, 80, 70, 255] },
      { assetId: sourceTwoId, width: 32, height: 64, color: [60, 50, 40, 255] },
    ];
    const oversized = await createHarness({ sources: oversizedSources });
    await expect(createPackSpritesheetTool(oversized.dependencies)({
      name: "too_tall", frames: [
        { sourceAssetId: sourceOneId, frameName: "left" },
        { sourceAssetId: sourceTwoId, frameName: "right" },
      ], paddingPixels: 16, maxTextureSize: 64,
    }, context("call-limit"))).rejects.toMatchObject({ code: "spritesheet_texture_limit_exceeded" });
    expect(oversized.objects.size).toBe(oversizedSources.length);
    expect(oversized.files.has(GENERATED_SPRITESHEET_MANIFEST_PATH)).toBe(false);
  });

  it("compensates partial Silo and workspace writes and permits recovery with the same call ID", async () => {
    const uploadFailure = await createHarness({ failUploadAt: 2 });
    await expect(createPackSpritesheetTool(uploadFailure.dependencies)(input(), context("call-upload-recover")))
      .rejects.toThrow("fixture_storage_write_failed");
    expect(uploadFailure.objects.size).toBe(sources.length);
    expect([...uploadFailure.files.keys()].some((path) => path.includes("/atlases/") && !path.endsWith("/manifest.json"))).toBe(false);

    const manifestFailure = await createHarness({ failWritePathOnce: GENERATED_SPRITESHEET_MANIFEST_PATH });
    const tool = createPackSpritesheetTool(manifestFailure.dependencies);
    const call = context("call-manifest-recover");
    await expect(tool(input(), call)).rejects.toThrow("fixture_workspace_write_failed");
    expect(manifestFailure.objects.size).toBe(sources.length);
    expect(manifestFailure.files.has(GENERATED_SPRITESHEET_MANIFEST_PATH)).toBe(false);
    expect([...manifestFailure.files.keys()].some((path) => path.includes("/atlases/") && !path.endsWith("/manifest.json"))).toBe(false);
    expect(await tool(input(), call)).toMatchObject({ format: "phaser-json-hash" });
  });
});

function input() {
  return {
    name: "hero_spritesheet",
    frames: [
      { sourceAssetId: sourceOneId, frameName: "run_0" },
      { sourceAssetId: sourceTwoId, frameName: "run_1" },
      { sourceAssetId: sourceThreeId, frameName: "run_2" },
    ],
    paddingPixels: 2,
    extrudePixels: 1,
    maxTextureSize: 64,
  };
}

function context(callId: string) {
  return { claim, callId, projectId, signal: new AbortController().signal };
}

async function createHarness(options: {
  sources?: readonly FixtureSource[];
  grid?: { columns: number; rows: number };
  failUploadAt?: number;
  failWritePathOnce?: string;
} = {}) {
  const frameSources = options.sources ?? sources;
  const grid = options.grid ?? { columns: 1, rows: 1 };
  const objects = new Map<string, { id: string; projectId: string; ownerUserId: string; body: Buffer; sha256: string; metadata: Record<string, unknown>; status: "ready" }>();
  const files = new Map<string, string | Uint8Array>([["public/assets/generated/manifest.json", JSON.stringify({
    schemaVersion: 1,
    assets: frameSources.map((source) => ({
      assetId: source.assetId,
      key: "generated-" + source.assetId,
      path: "assets/generated/" + source.assetId + ".png",
      assetType: "sprite",
      frameColumns: grid.columns,
      frameRows: grid.rows,
      frameWidth: source.width,
      frameHeight: source.height,
    })),
  })]]);
  for (const source of frameSources) {
    const bytes = await png(source.width * grid.columns, source.height * grid.rows, source.color);
    const checksum = sha256(bytes);
    objects.set(source.assetId, {
      id: source.assetId, projectId, ownerUserId: ownerId, body: bytes, sha256: checksum,
      metadata: generatedMetadata(source, grid, checksum), status: "ready",
    });
  }
  let uploadCount = 0;
  let failWritePath = options.failWritePathOnce;
  const sandbox = {
    files,
    async readFile(_project: string, path: string) {
      const content = files.get(path);
      if (typeof content !== "string") throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return { path, content };
    },
    async readBinaryFile(_project: string, path: string) {
      const content = files.get(path);
      if (!(content instanceof Uint8Array)) throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return content;
    },
    async writeBinaryFile(_project: string, path: string, bytes: Uint8Array) {
      files.set(path, Buffer.from(bytes));
      return { path, bytesWritten: bytes.byteLength };
    },
    async writeFile(_project: string, path: string, content: string) {
      files.set(path, content);
      if (path === failWritePath) {
        failWritePath = undefined;
        throw new Error("fixture_workspace_write_failed");
      }
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    },
    async deleteFile(_project: string, path: string) { return { path, deleted: files.delete(path) }; },
  };
  const storage = {
    async read(requestIdentity: VerifiedIdentityContext, assetId: string) {
      const object = objects.get(assetId);
      if (!object || requestIdentity.userId !== object.ownerUserId) throw new OwnedResourceNotFoundError();
      return {
        asset: {
          id: object.id, projectId: object.projectId, contentType: "image/png" as const,
          sizeBytes: object.body.byteLength, sha256: object.sha256, metadata: object.metadata,
        },
        body: Buffer.from(object.body),
      };
    },
    async upload(requestIdentity: VerifiedIdentityContext, request: {
      assetId?: string; projectId: string; contentType: "image/png" | "application/json"; body: Uint8Array; metadata: Record<string, unknown>;
    }) {
      uploadCount += 1;
      if (uploadCount === options.failUploadAt) throw new Error("fixture_storage_write_failed");
      const id = request.assetId!;
      const existing = objects.get(id);
      const bytes = Buffer.from(request.body);
      const checksum = sha256(bytes);
      if (existing) {
        if (existing.ownerUserId !== requestIdentity.userId || existing.sha256 !== checksum || !existing.body.equals(bytes)) {
          throw new Error("fixture_storage_idempotency_conflict");
        }
        return { id, sha256: checksum, status: "ready" as const, created: false };
      }
      objects.set(id, { id, ownerUserId: requestIdentity.userId, projectId: request.projectId, body: bytes, sha256: checksum, metadata: request.metadata, status: "ready" });
      return { id, sha256: checksum, status: "ready" as const, created: true };
    },
    async delete(requestIdentity: VerifiedIdentityContext, assetId: string) {
      const object = objects.get(assetId);
      if (object?.ownerUserId === requestIdentity.userId) objects.delete(assetId);
    },
  };
  return {
    objects,
    files,
    dependencies: { storage, sandbox, identity: async () => identity },
  };
}

function generatedMetadata(source: FixtureSource, grid: { columns: number; rows: number }, checksum: string) {
  return {
    schemaVersion: 1,
    source: "meta-model-api",
    assetType: "sprite",
    model: "fixture-image-model",
    prompt: "Synthetic local RGBA sprite fixture.",
    createdAt: "2026-11-03T00:00:00.000Z",
    responseId: "fixture-response-" + source.assetId.slice(-3),
    originalMimeType: "image/png",
    mimeType: "image/png",
    originalSha256: checksum,
    sha256: checksum,
    width: source.width * grid.columns,
    height: source.height * grid.rows,
    hasAlpha: true,
    transparentPixels: source.color[3] < 255,
    requestedTransparency: false,
    frames: { columns: grid.columns, rows: grid.rows, frameWidth: source.width, frameHeight: source.height },
    edits: ["png-reencoded"],
    qa: {
      contactSheetAssetId: "00000000-0000-4000-8000-000000000346",
      contactSheetSha256: sha256(Buffer.from("local-fixture")),
      visualReview: "pending-in-live-preview",
    },
  };
}

async function png(width: number, height: number, color: readonly [number, number, number, number]): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < raw.length; offset += 4) {
    raw[offset] = color[0];
    raw[offset + 1] = color[1];
    raw[offset + 2] = color[2];
    raw[offset + 3] = color[3];
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

async function sourcePixels(frameName: string): Promise<Buffer> {
  const source = sources[["run_0", "run_1", "run_2"].indexOf(frameName)]!;
  return sharp(await png(source.width, source.height, source.color)).ensureAlpha().raw().toBuffer();
}

function crop(
  raw: Buffer,
  atlasWidth: number,
  frame: { x: number; y: number; width: number; height: number },
): Buffer {
  const output = Buffer.alloc(frame.width * frame.height * 4);
  for (let row = 0; row < frame.height; row += 1) {
    const sourceOffset = ((frame.y + row) * atlasWidth + frame.x) * 4;
    raw.copy(output, row * frame.width * 4, sourceOffset, sourceOffset + frame.width * 4);
  }
  return output;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
