import { createHash } from "node:crypto";
import sharp from "sharp";
import type Phaser from "phaser";
import { describe, expect, it } from "vitest";
import {
  DefineAnimationInputJsonSchema,
  DefineAnimationInputSchema,
  DefineAnimationResultJsonSchema,
  DefineAnimationResultSchema,
} from "@meta-game/contracts";
import { identityFromAuthenticatedSession, OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import { createDefineAnimationTool, GENERATED_ANIMATION_INDEX_PATH } from "../../apps/worker/src/assets/define-animation";
import { getGeneratedAnimationTiming, registerGeneratedAnimations, type GeneratedAnimationManifest } from "../../packages/game-templates/phaser/src/game/generated-animations";

const ownerId = "user_animationOwner0001";
const otherOwnerId = "user_animationOther001";
const projectId = "00000000-0000-4000-8000-000000000351";
const atlasAssetId = "00000000-0000-4000-8000-000000000352";
const textureAssetId = "00000000-0000-4000-8000-000000000353";
const claim: RunWorkerClaim = {
  runId: "00000000-0000-4000-8000-000000000354",
  ownerUserId: ownerId,
  projectId,
  fencingToken: 1,
};
const identity = identityFromAuthenticatedSession({ userId: ownerId });

describe("define_animation", () => {
  it("exports strict 2020-12 input and result schemas and applies deterministic defaults", () => {
    const parsed = DefineAnimationInputSchema.parse({ atlasAssetId, animations: [{ key: "walk", frameNames: ["walk_0"] }] });
    expect(parsed.animations[0]).toMatchObject({ frameRate: 8, repeat: -1, yoyo: false, delayMs: 0, repeatDelayMs: 0 });
    expect(DefineAnimationInputJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      required: ["atlasAssetId", "animations"],
    });
    expect(DefineAnimationResultJsonSchema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      required: ["animationManifestAssetId", "atlasAssetId", "path", "sha256", "animations", "registration"],
      additionalProperties: false,
    });
    expect(DefineAnimationInputSchema.safeParse({ atlasAssetId, animations: [
      { key: "walk", frameNames: ["walk_0", "walk_0"] },
    ] }).success).toBe(false);
    expect(DefineAnimationInputSchema.safeParse({ atlasAssetId, animations: [
      { key: "walk", frameNames: ["walk_0"], repeat: -2 },
    ] }).success).toBe(false);
    expect(DefineAnimationResultSchema.safeParse({
      animationManifestAssetId: textureAssetId,
      atlasAssetId,
      path: "assets/generated/animations/" + textureAssetId + ".json",
      sha256: "a".repeat(64),
      animations: [{ key: "walk", frameNames: ["walk_0"], frameRate: 8, repeat: -1, yoyo: false, delayMs: 0, repeatDelayMs: 0 }],
      registration: "phaser-anims-create",
    }).success).toBe(true);
  });

  it("stores a versioned same-project manifest with explicit ordered frames and idempotent replay", async () => {
    const harness = await createHarness();
    const tool = createDefineAnimationTool(harness.dependencies);
    const call = context("call-animation-main");
    const request = input();
    const result = await tool(request, call);
    const stored = harness.objects.get(result.animationManifestAssetId)!;
    const manifest = JSON.parse(stored.body.toString("utf8")) as GeneratedAnimationManifest;
    expect(result).toMatchObject({
      atlasAssetId,
      path: "assets/generated/animations/" + result.animationManifestAssetId + ".json",
      sha256: sha256(stored.body),
      registration: "phaser-anims-create",
      animations: [
        { key: "walk", frameNames: ["walk_0", "walk_1", "walk_2"], frameRate: 6, repeat: -1, yoyo: false, delayMs: 0, repeatDelayMs: 0 },
        { key: "attack", frameNames: ["attack_0", "attack_1"], frameRate: 12, repeat: 1, yoyo: true, delayMs: 50, repeatDelayMs: 100 },
      ],
    });
    expect(manifest).toMatchObject({ schemaVersion: 1, animationManifestAssetId: result.animationManifestAssetId, atlasAssetId, atlasSha256: harness.atlasSha256 });
    expect(harness.files.get("public/" + result.path)).toEqual(stored.body.toString("utf8"));
    expect(JSON.parse(String(harness.files.get(GENERATED_ANIMATION_INDEX_PATH))).animations).toEqual([{
      animationManifestAssetId: result.animationManifestAssetId,
      atlasAssetId,
      atlasSha256: harness.atlasSha256,
      path: result.path,
      sha256: result.sha256,
      requestSha256: expect.any(String),
      keys: ["walk", "attack"],
    }]);
    expect(await tool(request, call)).toEqual(result);
    expect(harness.objects.size).toBe(3);
  });

  it("rejects missing/repeated frames, changed atlas bytes, key conflicts, and foreign owners before partial writes", async () => {
    const missingFrame = await createHarness();
    await expect(createDefineAnimationTool(missingFrame.dependencies)({
      atlasAssetId, animations: [{ key: "walk", frameNames: ["absent"] }],
    }, context("call-animation-missing"))).rejects.toMatchObject({ code: "animation_frame_missing" });
    expect(missingFrame.files.has(GENERATED_ANIMATION_INDEX_PATH)).toBe(false);
    expect(missingFrame.objects.size).toBe(2);

    const repeated = await createHarness();
    repeated.files.set("public/assets/generated/atlases/" + atlasAssetId + ".json", "{}");
    await expect(createDefineAnimationTool(repeated.dependencies)(input(), context("call-animation-changed-atlas")))
      .rejects.toMatchObject({ code: "animation_atlas_workspace_mismatch" });
    expect(repeated.files.has(GENERATED_ANIMATION_INDEX_PATH)).toBe(false);

    const conflict = await createHarness();
    const tool = createDefineAnimationTool(conflict.dependencies);
    await tool({ atlasAssetId, animations: [{ key: "walk", frameNames: ["walk_0"] }] }, context("call-animation-conflict-one"));
    await expect(tool({ atlasAssetId, animations: [{ key: "walk", frameNames: ["walk_1"] }] }, context("call-animation-conflict-two")))
      .rejects.toMatchObject({ code: "animation_key_conflict" });
    expect(conflict.objects.size).toBe(3);

    const foreign = await createHarness({ identity: identityFromAuthenticatedSession({ userId: otherOwnerId }) });
    const foreignClaim = { ...claim, ownerUserId: otherOwnerId };
    await expect(createDefineAnimationTool(foreign.dependencies)(input(), { ...context("call-animation-foreign"), claim: foreignClaim }))
      .rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    expect(foreign.files.has(GENERATED_ANIMATION_INDEX_PATH)).toBe(false);
  });

  it("rolls back an uploaded manifest after index write failure and permits replay", async () => {
    const harness = await createHarness({ failWritePathOnce: GENERATED_ANIMATION_INDEX_PATH });
    const tool = createDefineAnimationTool(harness.dependencies);
    const call = context("call-animation-recover");
    await expect(tool(input(), call)).rejects.toThrow("animation_index_write_failed");
    expect(harness.objects.size).toBe(2);
    expect(harness.files.has(GENERATED_ANIMATION_INDEX_PATH)).toBe(false);
    expect([...harness.files.keys()].some((path) => path.startsWith("public/assets/generated/animations/") && !path.endsWith("/manifest.json"))).toBe(false);
    expect(await tool(input(), call)).toMatchObject({ registration: "phaser-anims-create" });
  });
});

describe("Phaser generated animation helper", () => {
  it("registers exact named frames, rejects conflicts, and remains idempotent across scene recreation", () => {
    const manager = createManager();
    const scene = makeScene(manager);
    const manifest = runtimeManifest();
    expect(registerGeneratedAnimations(scene, { textureKey: "hero", assetId: atlasAssetId, sha256: "b".repeat(64) }, manifest)).toEqual(["walk"]);
    expect(manager.created).toHaveLength(1);
    expect(manager.created[0]).toMatchObject({
      key: "walk",
      frames: [{ key: "hero", frame: "walk_0" }, { key: "hero", frame: "walk_1" }],
      frameRate: 6,
      repeat: 2,
      yoyo: true,
      delay: 25,
      repeatDelay: 75,
    });
    expect(registerGeneratedAnimations(makeScene(manager), { textureKey: "hero", assetId: atlasAssetId, sha256: "b".repeat(64) }, manifest)).toEqual(["walk"]);
    expect(manager.created).toHaveLength(1);
    expect(manager.listenerRegistrations).toBe(0);
    expect(() => registerGeneratedAnimations(scene, { textureKey: "hero", assetId: atlasAssetId, sha256: "c".repeat(64) }, manifest))
      .toThrow("generated_animation_atlas_mismatch");
    expect(() => registerGeneratedAnimations(scene, { textureKey: "hero", assetId: atlasAssetId, sha256: "b".repeat(64) }, {
      ...manifest, animations: [{ ...manifest.animations[0]!, frameNames: ["not_in_atlas"] }],
    })).toThrow("generated_animation_frame_missing");
    const changed = { ...manifest, animations: [{ ...manifest.animations[0]!, frameRate: 7 }] };
    expect(() => registerGeneratedAnimations(scene, { textureKey: "hero", assetId: atlasAssetId, sha256: "b".repeat(64) }, changed))
      .toThrow("generated_animation_key_conflict:walk");
  });

  it("calculates frame order and bounded or infinite playback timing without using a live clock", () => {
    expect(getGeneratedAnimationTiming({
      key: "walk", frameNames: ["walk_0", "walk_1", "walk_2"], frameRate: 6, repeat: -1,
      yoyo: false, delayMs: 50, repeatDelayMs: 100,
    })).toEqual({ frameDurationMs: 1_000 / 6, frameNames: ["walk_0", "walk_1", "walk_2"], repeat: -1, yoyo: false, totalDurationMs: null });
    expect(getGeneratedAnimationTiming({
      key: "attack", frameNames: ["attack_0", "attack_1"], frameRate: 10, repeat: 1,
      yoyo: true, delayMs: 50, repeatDelayMs: 100,
    }).totalDurationMs).toBe(650);
  });
});

function input() {
  return {
    atlasAssetId,
    animations: [
      { key: "walk", frameNames: ["walk_0", "walk_1", "walk_2"], frameRate: 6 },
      { key: "attack", frameNames: ["attack_0", "attack_1"], frameRate: 12, repeat: 1, yoyo: true, delayMs: 50, repeatDelayMs: 100 },
    ],
  };
}

function context(callId: string) {
  return { claim, callId, projectId, signal: new AbortController().signal };
}

async function createHarness(options: { identity?: VerifiedIdentityContext; failWritePathOnce?: string } = {}) {
  const texture = await sharp({ create: { width: 12, height: 2, channels: 4, background: { r: 45, g: 80, b: 120, alpha: 1 } } }).png().toBuffer();
  const textureSha = sha256(texture);
  const frameNames = ["walk_0", "walk_1", "walk_2", "attack_0", "attack_1"];
  const frameEntries = Object.fromEntries(frameNames.map((frameName, index) => [frameName, {
    frame: { x: index * 2, y: 0, w: 2, h: 2 }, rotated: false, trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: 2, h: 2 }, sourceSize: { w: 2, h: 2 }, pivot: { x: 0.5, y: 1 },
  }]));
  const atlasBody = Buffer.from(JSON.stringify({
    frames: frameEntries,
    meta: {
      image: textureAssetId + ".png", size: { w: 12, h: 2 }, schemaVersion: 1,
      engine: "phaser-3.90.0", atlasFormat: "phaser-json-hash", sha256: textureSha,
      provenance: frameNames.map((frameName) => ({ frameName, sourceAssetId: textureAssetId, sourceFrameIndex: 0, sourceSha256: "c".repeat(64) })),
    },
  }, null, 2) + "\n");
  const atlasSha = sha256(atlasBody);
  const metadata = {
    schemaVersion: 1, engine: "phaser-3.90.0", format: "phaser-json-hash", atlasAssetId, textureAssetId,
    name: "hero_spritesheet", atlasPath: `assets/generated/atlases/${atlasAssetId}.json`,
    imagePath: `assets/generated/atlases/${textureAssetId}.png`, sha256: textureSha, atlasSha256: atlasSha,
    width: 12, height: 2, paddingPixels: 0, extrudePixels: 0,
    frames: frameNames.map((frameName, index) => ({
      frameName, x: index * 2, y: 0, width: 2, height: 2, pivot: { x: 0.5, y: 1 },
      sourceAssetId: textureAssetId, sourceFrameIndex: 0, sourceSha256: "c".repeat(64),
    })),
  };
  const files = new Map<string, string | Uint8Array>([
    ["public/assets/generated/atlases/manifest.json", JSON.stringify({ schemaVersion: 1, spritesheets: [{
      atlasAssetId, textureAssetId, name: "hero_spritesheet", atlasPath: metadata.atlasPath, imagePath: metadata.imagePath,
      sha256: textureSha, requestSha256: "d".repeat(64), width: 12, height: 2, frameCount: frameNames.length,
    }] })],
    ["public/" + metadata.atlasPath, atlasBody.toString("utf8")],
    ["public/" + metadata.imagePath, texture],
  ]);
  const objects = new Map<string, { id: string; projectId: string; ownerUserId: string; contentType: string; sizeBytes: number; sha256: string; metadata: Record<string, unknown>; body: Buffer; status: "ready" }>();
  objects.set(atlasAssetId, { id: atlasAssetId, projectId, ownerUserId: ownerId, contentType: "application/json", sizeBytes: atlasBody.byteLength, sha256: atlasSha, metadata: { ...metadata, assetType: "spritesheet-atlas", companionAssetId: textureAssetId }, body: atlasBody, status: "ready" });
  objects.set(textureAssetId, { id: textureAssetId, projectId, ownerUserId: ownerId, contentType: "image/png", sizeBytes: texture.byteLength, sha256: textureSha, metadata: { assetType: "spritesheet-texture", companionAssetId: atlasAssetId }, body: texture, status: "ready" });
  let failWritePath = options.failWritePathOnce;
  const dependencies = {
    identity: async () => options.identity ?? identity,
    storage: {
      async read(_identity: VerifiedIdentityContext, assetId: string) {
        const item = objects.get(assetId);
        if (!item || item.ownerUserId !== _identity.userId) throw new OwnedResourceNotFoundError();
        return { asset: item, body: item.body };
      },
      async upload(_identity: VerifiedIdentityContext, request: { assetId?: string; projectId: string; contentType: "image/png" | "application/json"; body: Uint8Array; metadata: Record<string, unknown> }) {
        const assetId = request.assetId ?? "00000000-0000-4000-8000-000000000356";
        const body = Buffer.from(request.body);
        const digest = sha256(body);
        const existing = objects.get(assetId);
        if (existing) return { id: assetId, sha256: existing.sha256, status: "ready" as const, created: false };
        objects.set(assetId, { id: assetId, projectId: request.projectId, ownerUserId: _identity.userId, contentType: request.contentType, sizeBytes: body.byteLength, sha256: digest, metadata: request.metadata, body, status: "ready" });
        return { id: assetId, sha256: digest, status: "ready" as const, created: true };
      },
      async delete(_identity: VerifiedIdentityContext, assetId: string) { objects.delete(assetId); },
    },
    sandbox: {
      async readFile(_projectId: string, path: string) {
        const content = files.get(path);
        if (typeof content !== "string") throw Object.assign(new Error("missing"), { code: "file_not_found" });
        return { path, content };
      },
      async readBinaryFile(_projectId: string, path: string) {
        const body = files.get(path);
        if (!(body instanceof Uint8Array)) throw Object.assign(new Error("missing"), { code: "file_not_found" });
        return body;
      },
      async writeFile(_projectId: string, path: string, content: string) {
        if (failWritePath === path) {
          failWritePath = undefined;
          throw new Error("fixture_workspace_write_failed");
        }
        files.set(path, content);
        return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
      },
      async deleteFile(_projectId: string, path: string) { return { path, deleted: files.delete(path) }; },
    },
  };
  return { dependencies, files, objects, atlasSha256: atlasSha };
}

function createManager() {
  const animations = new Set<string>();
  const manager = {
    created: [] as Array<Record<string, unknown>>,
    listenerRegistrations: 0,
    exists: (key: string) => animations.has(key),
    create(config: Record<string, unknown>) {
      const key = String(config.key);
      if (animations.has(key)) return null;
      animations.add(key);
      manager.created.push(config);
      return { key };
    },
    on() { manager.listenerRegistrations += 1; return manager; },
    once() { manager.listenerRegistrations += 1; return manager; },
  };
  return manager;
}

function makeScene(manager: ReturnType<typeof createManager>) {
  return {
    anims: manager,
    textures: {
      exists: (key: string) => key === "hero",
      get: () => ({ getFrameNames: () => ["walk_0", "walk_1", "walk_2", "attack_0", "attack_1"] }),
    },
  } as unknown as Phaser.Scene;
}

function runtimeManifest(): GeneratedAnimationManifest {
  return {
    schemaVersion: 1,
    animationManifestAssetId: "00000000-0000-4000-8000-000000000355",
    atlasAssetId,
    atlasSha256: "b".repeat(64),
    animations: [{ key: "walk", frameNames: ["walk_0", "walk_1"], frameRate: 6, repeat: 2, yoyo: true, delayMs: 25, repeatDelayMs: 75 }],
  };
}

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
