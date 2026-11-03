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
import { createPackSpritesheetTool, type PackSpritesheetToolContext } from "../../apps/worker/src/assets/pack-spritesheet";
import { createDefineAnimationTool, type DefineAnimationToolContext } from "../../apps/worker/src/assets/define-animation";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";
type SourceDescriptor = { assetId: string; body: Buffer; width: number; height: number; columns: number; rows: number; colors: readonly (readonly [number, number, number, number])[] };

describe.skipIf(!integrationEnabled)("pack_spritesheet con PostgreSQL, Silo y ownership", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const ownerA = "user_spritesheetOwnerA" + suffix;
  const ownerB = "user_spritesheetOwnerB" + suffix;
  const identityA = identityFromAuthenticatedSession({ userId: ownerA });
  const identityB = identityFromAuthenticatedSession({ userId: ownerB });
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;
  let storage: ReturnType<typeof createPrivateStorageFromEnvironment>;
  let projectA: string;
  let projectB: string;
  let claimA: RunWorkerClaim;
  let sourceDescriptors: SourceDescriptor[];
  const created: Array<{ identity: typeof identityA; id: string }> = [];

  beforeAll(async () => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
    storage = createPrivateStorageFromEnvironment(repositories.assets);
    const [forA, forB] = await Promise.all([
      repositories.projects.create(identityA, { name: "Spritesheet acceptance owner A" }),
      repositories.projects.create(identityB, { name: "Spritesheet acceptance owner B" }),
    ]);
    projectA = forA.id;
    projectB = forB.id;
    claimA = { runId: randomUUID(), ownerUserId: ownerA, projectId: projectA, fencingToken: 1 };
    sourceDescriptors = [
      await createSource(16, 16, 2, 1, [[35, 115, 230, 255], [230, 190, 35, 255]], true),
      await createSource(24, 12, 1, 1, [[180, 70, 225, 255]]),
      await createSource(12, 20, 1, 1, [[38, 220, 80, 255]]),
    ];
    for (const source of sourceDescriptors) {
      const checksum = sha256(source.body);
      const saved = await storage.upload(identityA, {
        projectId: projectA,
        contentType: "image/png",
        body: source.body,
        metadata: sourceMetadata(source, checksum),
      });
      source.assetId = saved.id;
      created.push({ identity: identityA, id: saved.id });
    }
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

  it("extracts real source frames, stores a deterministic Phaser atlas/texture pair in Silo, and returns the durable replay", async () => {
    const sandbox = makeSandbox(projectA, sourceDescriptors);
    const tool = createPackSpritesheetTool({ storage, sandbox, identity: async () => identityA });
    const context: PackSpritesheetToolContext = {
      claim: claimA,
      callId: "pack-spritesheet-acceptance",
      projectId: projectA,
      signal: new AbortController().signal,
    };
    const request = {
      name: "acceptance_hero",
      frames: [
        { sourceAssetId: sourceDescriptors[0]!.assetId, sourceFrameIndex: 0, frameName: "run_0" },
        { sourceAssetId: sourceDescriptors[0]!.assetId, sourceFrameIndex: 1, frameName: "run_1" },
        { sourceAssetId: sourceDescriptors[1]!.assetId, sourceFrameIndex: 0, frameName: "run_2" },
        { sourceAssetId: sourceDescriptors[2]!.assetId, sourceFrameIndex: 0, frameName: "run_3" },
      ],
      paddingPixels: 2,
      extrudePixels: 1,
      maxTextureSize: 128,
    };
    const result = await tool(request, context);
    const storedTexture = await storage.read(identityA, result.textureAssetId);
    const storedAtlas = await storage.read(identityA, result.atlasAssetId);
    created.push({ identity: identityA, id: result.textureAssetId }, { identity: identityA, id: result.atlasAssetId });
    const atlas = JSON.parse(Buffer.from(storedAtlas.body).toString("utf8")) as {
      frames: Record<string, {
        frame: { x: number; y: number; w: number; h: number };
        rotated: boolean;
        trimmed: boolean;
        spriteSourceSize: { x: number; y: number; w: number; h: number };
        sourceSize: { w: number; h: number };
        pivot: { x: number; y: number };
      }>;
      meta: { image: string; size: { w: number; h: number }; sha256: string; provenance: Array<{ frameName: string; sourceAssetId: string; sourceFrameIndex: number; sourceSha256: string }> };
    };
    const texturePixels = await sharp(Buffer.from(storedTexture.body)).raw().toBuffer({ resolveWithObject: true });
    expect(result).toMatchObject({
      atlasAssetId: storedAtlas.asset.id,
      textureAssetId: storedTexture.asset.id,
      sha256: storedTexture.asset.sha256,
      format: "phaser-json-hash",
      frames: [
        { frameName: "run_0", width: 16, height: 16 },
        { frameName: "run_1", width: 16, height: 16 },
        { frameName: "run_2", width: 24, height: 12 },
        { frameName: "run_3", width: 12, height: 20 },
      ],
    });
    expect(result.width).toBe(texturePixels.info.width);
    expect(result.height).toBe(texturePixels.info.height);
    expect(result.width).toBeLessThanOrEqual(128);
    expect(result.height).toBeLessThanOrEqual(128);
    expect(atlas.meta).toMatchObject({
      image: result.textureAssetId + ".png",
      size: { w: result.width, h: result.height },
      sha256: result.sha256,
    });
    expect(storedTexture.asset.projectId).toBe(projectA);
    expect(storedAtlas.asset.projectId).toBe(projectA);
    expect(storedTexture.asset.metadata).toMatchObject({
      schemaVersion: 1,
      assetType: "spritesheet-texture",
      companionAssetId: result.atlasAssetId,
    });
    expect(storedAtlas.asset.metadata).toMatchObject({
      schemaVersion: 1,
      assetType: "spritesheet-atlas",
      atlasSha256: sha256(storedAtlas.body),
      companionAssetId: result.textureAssetId,
    });
    expect(Buffer.from(storedTexture.body)).toEqual(Buffer.from(sandbox.files.get("public/" + result.imagePath) as Uint8Array));
    expect(Buffer.from(storedAtlas.body)).toEqual(Buffer.from(sandbox.files.get("public/" + result.atlasPath) as string));
    expect(atlas.meta.provenance).toMatchObject([
      { frameName: "run_0", sourceAssetId: sourceDescriptors[0]!.assetId, sourceFrameIndex: 0 },
      { frameName: "run_1", sourceAssetId: sourceDescriptors[0]!.assetId, sourceFrameIndex: 1 },
      { frameName: "run_2", sourceAssetId: sourceDescriptors[1]!.assetId, sourceFrameIndex: 0 },
      { frameName: "run_3", sourceAssetId: sourceDescriptors[2]!.assetId, sourceFrameIndex: 0 },
    ]);
    for (const frame of result.frames) {
      const descriptor = atlas.frames[frame.frameName]!;
      expect(descriptor).toMatchObject({
        frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: frame.width, h: frame.height },
        sourceSize: { w: frame.width, h: frame.height },
        pivot: { x: 0.5, y: 1 },
      });
      const source = sourceDescriptors.find(({ assetId }) => assetId === atlas.meta.provenance.find((item) => item.frameName === frame.frameName)?.sourceAssetId)!;
      const sourceFrameIndex = atlas.meta.provenance.find((item) => item.frameName === frame.frameName)!.sourceFrameIndex;
      const expected = await sharp(source.body)
        .extract({ left: sourceFrameIndex * source.width, top: 0, width: frame.width, height: frame.height })
        .ensureAlpha().raw().toBuffer();
      const actual = crop(texturePixels.data, texturePixels.info.width, frame);
      expect(actual).toEqual(expected);
    }

    const animationTool = createDefineAnimationTool({ storage, sandbox, identity: async () => identityA });
    const animationContext: DefineAnimationToolContext = {
      claim: claimA,
      callId: "define-animation-acceptance",
      projectId: projectA,
      signal: new AbortController().signal,
    };
    const animationInput = {
      atlasAssetId: result.atlasAssetId,
      animations: [
        { key: "acceptance-run", frameNames: ["run_0", "run_1", "run_2"], frameRate: 6, repeat: -1 },
        { key: "acceptance-yoyo", frameNames: ["run_0", "run_1"], frameRate: 8, repeat: 1, yoyo: true, delayMs: 50, repeatDelayMs: 25 },
      ],
    };
    const animationResult = await animationTool(animationInput, animationContext);
    const storedAnimation = await storage.read(identityA, animationResult.animationManifestAssetId);
    created.push({ identity: identityA, id: animationResult.animationManifestAssetId });
    expect(animationResult).toMatchObject({
      atlasAssetId: result.atlasAssetId,
      registration: "phaser-anims-create",
      animations: [
        { key: "acceptance-run", frameNames: ["run_0", "run_1", "run_2"], frameRate: 6, repeat: -1, yoyo: false },
        { key: "acceptance-yoyo", frameNames: ["run_0", "run_1"], frameRate: 8, repeat: 1, yoyo: true, delayMs: 50, repeatDelayMs: 25 },
      ],
    });
    expect(Buffer.from(storedAnimation.body)).toEqual(Buffer.from(sandbox.files.get("public/" + animationResult.path) as string));
    expect(await animationTool(animationInput, animationContext)).toEqual(animationResult);
    await expect(animationTool({
      atlasAssetId: result.atlasAssetId,
      animations: [{ key: "acceptance-run", frameNames: ["run_0"] }],
    }, { ...animationContext, callId: "define-animation-key-conflict" })).rejects.toMatchObject({ code: "animation_key_conflict" });

    const foreignSandbox = makeSandbox(projectB, sourceDescriptors);
    for (const [path, content] of sandbox.files) {
      if (path.includes("/atlases/")) foreignSandbox.files.set(path, content);
    }
    const foreignClaim: RunWorkerClaim = { runId: randomUUID(), ownerUserId: ownerB, projectId: projectB, fencingToken: 1 };
    const foreignAnimationTool = createDefineAnimationTool({ storage, sandbox: foreignSandbox, identity: async () => identityB });
    await expect(foreignAnimationTool({ atlasAssetId: result.atlasAssetId, animations: [{ key: "foreign-run", frameNames: ["run_0"] }] }, {
      claim: foreignClaim,
      callId: "define-animation-cross-owner",
      projectId: projectB,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    expect(foreignSandbox.files.has("public/assets/generated/animations/manifest.json")).toBe(false);

    const repeat = await tool(request, context);
    expect(repeat).toEqual(result);
    const artifactPath = process.env.ISSUE_34_SPRITESHEET_PREVIEW_ARTIFACT;
    if (artifactPath) {
      await writeFile(artifactPath, JSON.stringify({
        result,
        imageBase64: Buffer.from(storedTexture.body).toString("base64"),
        atlasBase64: Buffer.from(storedAtlas.body).toString("base64"),
        animationResult,
        animationManifestBase64: Buffer.from(storedAnimation.body).toString("base64"),
      }), { encoding: "utf8", flag: "wx" });
    }
  });

  it("rejects a same-UUID private asset owned by another project before writing any atlas objects", async () => {
    const source = sourceDescriptors[0]!;
    const foreignSandbox = makeSandbox(projectB, [source]);
    const foreignClaim: RunWorkerClaim = { runId: randomUUID(), ownerUserId: ownerB, projectId: projectB, fencingToken: 1 };
    const tool = createPackSpritesheetTool({ storage, sandbox: foreignSandbox, identity: async () => identityB });
    await expect(tool({
      name: "foreign_sheet",
      frames: [{ sourceAssetId: source.assetId, sourceFrameIndex: 0, frameName: "hero" }],
    }, {
      claim: foreignClaim,
      callId: "foreign-spritesheet-source",
      projectId: projectB,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    expect(foreignSandbox.files.has("public/assets/generated/atlases/manifest.json")).toBe(false);
  });
});

function makeSandbox(projectId: string, sources: readonly SourceDescriptor[]) {
  const files = new Map<string, string | Uint8Array>([["public/assets/generated/manifest.json", JSON.stringify({
    schemaVersion: 1,
    assets: sources.map((source) => ({
      assetId: source.assetId,
      key: "generated-" + source.assetId,
      path: "assets/generated/" + source.assetId + ".png",
      assetType: "sprite",
      frameColumns: source.columns,
      frameRows: source.rows,
      frameWidth: source.width,
      frameHeight: source.height,
    })),
  })]]);
  return {
    files,
    async readFile(_projectId: string, path: string) {
      const value = files.get(path);
      if (typeof value !== "string") throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return { path, content: value };
    },
    async readBinaryFile(_projectId: string, path: string) {
      const value = files.get(path);
      if (!(value instanceof Uint8Array)) throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return value;
    },
    async writeBinaryFile(_projectId: string, path: string, body: Uint8Array) {
      files.set(path, Buffer.from(body));
      return { path, bytesWritten: body.byteLength };
    },
    async writeFile(_projectId: string, path: string, content: string) {
      files.set(path, content);
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    },
    async deleteFile(_projectId: string, path: string) { return { path, deleted: files.delete(path) }; },
  };
}

async function createSource(
  width: number,
  height: number,
  columns: number,
  rows: number,
  colors: readonly (readonly [number, number, number, number])[],
  transparentPixel = false,
): Promise<SourceDescriptor> {
  const raw = Buffer.alloc(width * columns * height * rows * 4);
  for (let y = 0; y < height * rows; y += 1) {
    for (let x = 0; x < width * columns; x += 1) {
      const color = colors[Math.floor(x / width)]!;
      const offset = (y * width * columns + x) * 4;
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = color[3];
    }
  }
  if (transparentPixel) raw.set([4, 8, 12, 0], 0);
  const body = await sharp(raw, { raw: { width: width * columns, height: height * rows, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  return { assetId: randomUUID(), body, width, height, columns, rows, colors };
}

function sourceMetadata(source: SourceDescriptor, checksum: string) {
  const transparent = source.body.byteLength > 0 && source.body[3] === 0;
  return {
    schemaVersion: 1,
    source: "meta-model-api",
    assetType: "sprite",
    model: "fixture-image-model",
    prompt: "Synthetic local sprite frames for the Phaser atlas acceptance fixture.",
    createdAt: "2026-11-03T00:00:00.000Z",
    responseId: "fixture-response-" + source.assetId.slice(-6),
    originalMimeType: "image/png",
    mimeType: "image/png",
    originalSha256: checksum,
    sha256: checksum,
    width: source.width * source.columns,
    height: source.height * source.rows,
    hasAlpha: true,
    transparentPixels: transparent,
    requestedTransparency: transparent,
    frames: { columns: source.columns, rows: source.rows, frameWidth: source.width, frameHeight: source.height },
    edits: ["png-reencoded"],
    qa: {
      contactSheetAssetId: randomUUID(),
      contactSheetSha256: sha256(Buffer.from("local-fixture")),
      visualReview: "pending-in-live-preview",
    },
  };
}

function crop(raw: Buffer, atlasWidth: number, frame: { x: number; y: number; width: number; height: number }): Buffer {
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
