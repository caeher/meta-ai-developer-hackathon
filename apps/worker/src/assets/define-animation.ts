import { createHash, createHmac } from "node:crypto";
import {
  DefineAnimationInputSchema,
  DefineAnimationManifestIndexSchema,
  DefineAnimationResultSchema,
  GeneratedAnimationManifestSchema,
  PackSpritesheetManifestSchema,
  PackSpritesheetMetadataSchema,
  type DefineAnimationManifestIndex,
  type DefineAnimationResult,
  type GeneratedAnimationManifest,
  type PackSpritesheetMetadata,
} from "@meta-game/contracts";
import { OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import type { SandboxControllerClient } from "@meta-game/sandbox";
import type { SpritesheetStorage } from "./pack-spritesheet";

export const GENERATED_ANIMATION_INDEX_PATH = "public/assets/generated/animations/manifest.json";
const ANIMATION_DIRECTORY = "assets/generated/animations";
const MAX_ANIMATION_FILE_BYTES = 256 * 1024;
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_ATLAS_BYTES = 256 * 1024;

type AnimationSandbox = Pick<SandboxControllerClient, "readFile" | "readBinaryFile" | "writeFile" | "deleteFile">;
export type DefineAnimationToolContext = Readonly<{ claim: RunWorkerClaim; callId: string; projectId: string; signal: AbortSignal }>;
type AnimationAtlasStorage = Pick<SpritesheetStorage, "read" | "upload" | "delete">;
export class DefineAnimationToolError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "DefineAnimationToolError";
  }
}

export function createDefineAnimationTool(input: {
  storage: AnimationAtlasStorage;
  sandbox: AnimationSandbox;
  identity(claim: RunWorkerClaim): Promise<VerifiedIdentityContext>;
}) {
  return async function defineAnimationTool(rawInput: Record<string, unknown>, context: DefineAnimationToolContext): Promise<DefineAnimationResult> {
    const parsed = DefineAnimationInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new Error("agent_invalid_tool_arguments");
    if (context.projectId !== context.claim.projectId || !context.callId || context.callId.length > 200) {
      throw new OwnedResourceNotFoundError();
    }
    context.signal.throwIfAborted();

    const identity = await input.identity(context.claim);
    if (identity.userId !== context.claim.ownerUserId) throw new OwnedResourceNotFoundError();
    const atlas = await loadAtlas(input.storage, input.sandbox, identity, context.projectId, parsed.data.atlasAssetId, context.signal);
    for (const animation of parsed.data.animations) {
      const missing = animation.frameNames.find((frameName) => !atlas.frameNames.has(frameName));
      if (missing) throw new DefineAnimationToolError("animation_frame_missing");
    }

    const animationManifestAssetId = deterministicUuid(`${context.claim.runId}\0${context.callId}\0animation-manifest`);
    const path = `${ANIMATION_DIRECTORY}/${animationManifestAssetId}.json`;
    const workspacePath = `public/${path}`;
    const definitions = parsed.data.animations.map((animation) => ({
      key: animation.key,
      frameNames: [...animation.frameNames],
      frameRate: animation.frameRate,
      repeat: animation.repeat,
      yoyo: animation.yoyo,
      delayMs: animation.delayMs,
      repeatDelayMs: animation.repeatDelayMs,
    }));
    const durableManifest: GeneratedAnimationManifest = GeneratedAnimationManifestSchema.parse({
      schemaVersion: 1,
      animationManifestAssetId,
      atlasAssetId: parsed.data.atlasAssetId,
      atlasSha256: atlas.sha256,
      animations: definitions,
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(durableManifest, null, 2)}\n`, "utf8");
    if (manifestBytes.byteLength > MAX_ANIMATION_FILE_BYTES) throw new DefineAnimationToolError("animation_manifest_too_large");
    const manifestSha256 = sha256(manifestBytes);
    const requestSha256 = sha256(Buffer.from(canonicalJson(parsed.data), "utf8"));
    const result = DefineAnimationResultSchema.parse({
      animationManifestAssetId,
      atlasAssetId: atlas.atlasAssetId,
      path,
      sha256: manifestSha256,
      animations: definitions,
      registration: "phaser-anims-create",
    });

    const oldIndexText = await readOptionalText(input.sandbox, context.projectId, GENERATED_ANIMATION_INDEX_PATH, context.signal);
    const index = parseIndex(oldIndexText);
    const existingById = index.animations.find((entry) => entry.animationManifestAssetId === animationManifestAssetId);
    const conflictingKey = index.animations.some((entry) => entry.keys.some((key) => definitions.some((animation) => animation.key === key)) &&
      entry.animationManifestAssetId !== animationManifestAssetId);
    if (conflictingKey) throw new DefineAnimationToolError("animation_key_conflict");

    const indexEntry = {
      animationManifestAssetId,
      atlasAssetId: atlas.atlasAssetId,
      atlasSha256: atlas.sha256,
      path,
      sha256: manifestSha256,
      requestSha256,
      keys: definitions.map(({ key }) => key),
    };
    if (existingById && JSON.stringify(existingById) !== JSON.stringify(indexEntry)) {
      throw new DefineAnimationToolError("animation_idempotency_conflict");
    }
    const updatedIndex: DefineAnimationManifestIndex = DefineAnimationManifestIndexSchema.parse({
      schemaVersion: 1,
      animations: existingById ? index.animations : [...index.animations, indexEntry],
    });
    const updatedIndexText = `${JSON.stringify(updatedIndex, null, 2)}\n`;
    if (Buffer.byteLength(updatedIndexText, "utf8") > MAX_INDEX_BYTES) throw new DefineAnimationToolError("animation_index_too_large");
    if (!existingById && updatedIndex.animations.length > 128) throw new DefineAnimationToolError("animation_index_limit");

    const oldManifestText = await readOptionalText(input.sandbox, context.projectId, workspacePath, context.signal);
    if (oldManifestText !== undefined && oldManifestText !== manifestBytes.toString("utf8")) {
      throw new DefineAnimationToolError("animation_workspace_conflict");
    }
    const assetMetadata = {
      schemaVersion: 1,
      assetType: "animation-manifest",
      animationManifestAssetId,
      atlasAssetId: atlas.atlasAssetId,
      atlasSha256: atlas.sha256,
      path,
      sha256: manifestSha256,
      requestSha256,
      runId: context.claim.runId,
      callId: context.callId,
    };
    let uploaded = false;
    let fileWriteAttempted = false;
    let indexWriteAttempted = false;
    try {
      context.signal.throwIfAborted();
      const stored = await input.storage.upload(identity, {
        assetId: animationManifestAssetId,
        projectId: context.projectId,
        contentType: "application/json",
        body: manifestBytes,
        metadata: assetMetadata,
      });
      uploaded = stored.id === animationManifestAssetId && stored.created !== false;
      if (stored.id !== animationManifestAssetId || stored.status !== "ready" || stored.sha256 !== manifestSha256) {
        throw new DefineAnimationToolError("animation_storage_failed");
      }

      context.signal.throwIfAborted();
      if (oldManifestText === undefined) {
        fileWriteAttempted = true;
        try {
          const written = await input.sandbox.writeFile(context.projectId, workspacePath, manifestBytes.toString("utf8"), context.signal);
          if (written.bytesWritten !== manifestBytes.byteLength) throw new DefineAnimationToolError("animation_workspace_write_failed");
        } catch (error) {
          if (context.signal.aborted || error instanceof DefineAnimationToolError) throw error;
          throw new DefineAnimationToolError("animation_workspace_write_failed");
        }
      }
      if (!existingById) {
        indexWriteAttempted = true;
        try {
          const written = await input.sandbox.writeFile(context.projectId, GENERATED_ANIMATION_INDEX_PATH, updatedIndexText, context.signal);
          if (written.bytesWritten !== Buffer.byteLength(updatedIndexText, "utf8")) throw new DefineAnimationToolError("animation_index_write_failed");
        } catch (error) {
          if (context.signal.aborted || error instanceof DefineAnimationToolError) throw error;
          throw new DefineAnimationToolError("animation_index_write_failed");
        }
      }
      context.signal.throwIfAborted();
      return result;
    } catch (error) {
      const cleanupSignal = new AbortController().signal;
      if (indexWriteAttempted) await restoreWorkspaceFile(input.sandbox, context.projectId, GENERATED_ANIMATION_INDEX_PATH, oldIndexText, cleanupSignal);
      if (fileWriteAttempted) await removeWorkspaceFile(input.sandbox, context.projectId, workspacePath, cleanupSignal);
      if (uploaded) await input.storage.delete(identity, animationManifestAssetId).catch(() => undefined);
      throw error;
    }
  };
}

type LoadedAtlas = Readonly<{ atlasAssetId: string; sha256: string; frameNames: ReadonlySet<string> }>;

async function loadAtlas(
  storage: AnimationAtlasStorage,
  sandbox: AnimationSandbox,
  identity: VerifiedIdentityContext,
  projectId: string,
  atlasAssetId: string,
  signal: AbortSignal,
): Promise<LoadedAtlas> {
  const indexText = await readRequiredText(sandbox, projectId, "public/assets/generated/atlases/manifest.json", signal, "animation_atlas_manifest_missing");
  if (Buffer.byteLength(indexText, "utf8") > MAX_INDEX_BYTES) throw new DefineAnimationToolError("animation_atlas_manifest_too_large");
  let sheetIndex: ReturnType<typeof PackSpritesheetManifestSchema.parse>;
  try {
    sheetIndex = PackSpritesheetManifestSchema.parse(JSON.parse(indexText) as unknown);
  } catch {
    throw new DefineAnimationToolError("animation_atlas_manifest_invalid");
  }
  const entry = sheetIndex.spritesheets.find((candidate) => candidate.atlasAssetId === atlasAssetId);
  if (!entry) throw new OwnedResourceNotFoundError();

  let stored: Awaited<ReturnType<AnimationAtlasStorage["read"]>>;
  try {
    stored = await storage.read(identity, atlasAssetId);
  } catch (error) {
    if (error instanceof OwnedResourceNotFoundError) throw error;
    throw new DefineAnimationToolError("animation_atlas_unavailable");
  }
  if (stored.asset.id !== atlasAssetId || stored.asset.projectId !== projectId) throw new OwnedResourceNotFoundError();
  if (stored.asset.contentType !== "application/json" || stored.asset.sizeBytes < 1 || stored.asset.sizeBytes > MAX_ATLAS_BYTES ||
      stored.body.byteLength !== stored.asset.sizeBytes || !isSha256(stored.asset.sha256) || sha256(stored.body) !== stored.asset.sha256) {
    throw new DefineAnimationToolError("animation_atlas_integrity_invalid");
  }
  const assetMetadata = stored.asset.metadata ?? {};
  const metadata = PackSpritesheetMetadataSchema.safeParse(selectAtlasMetadata(assetMetadata));
  if (!metadata.success || assetMetadata.assetType !== "spritesheet-atlas" || assetMetadata.companionAssetId !== metadata.data.textureAssetId ||
      metadata.data.atlasAssetId !== atlasAssetId || metadata.data.atlasPath !== entry.atlasPath || metadata.data.name !== entry.name ||
      metadata.data.sha256 !== entry.sha256 || metadata.data.frames.length !== entry.frameCount || stored.asset.sha256 !== metadata.data.atlasSha256) {
    throw new DefineAnimationToolError("animation_atlas_metadata_invalid");
  }

  const atlasPath = `public/${entry.atlasPath}`;
  const workspaceAtlas = await readRequiredText(sandbox, projectId, atlasPath, signal, "animation_atlas_workspace_missing");
  const atlasBytes = Buffer.from(workspaceAtlas, "utf8");
  if (sha256(atlasBytes) !== stored.asset.sha256 || !Buffer.from(stored.body).equals(atlasBytes)) {
    throw new DefineAnimationToolError("animation_atlas_workspace_mismatch");
  }
  let descriptor: unknown;
  try {
    descriptor = JSON.parse(workspaceAtlas) as unknown;
  } catch {
    throw new DefineAnimationToolError("animation_atlas_invalid");
  }
  const atlas = parseAtlasDescriptor(descriptor, metadata.data.frames);
  if (!atlas || atlas.image !== `${metadata.data.textureAssetId}.png` || atlas.textureSha256 !== entry.sha256 ||
      atlas.width !== metadata.data.width || atlas.height !== metadata.data.height) {
    throw new DefineAnimationToolError("animation_atlas_invalid");
  }
  const textureAsset = await storage.read(identity, metadata.data.textureAssetId);
  if (textureAsset.asset.id !== metadata.data.textureAssetId || textureAsset.asset.projectId !== projectId) throw new OwnedResourceNotFoundError();
  const textureMetadata = textureAsset.asset.metadata ?? {};
  if (textureAsset.asset.contentType !== "image/png" || textureAsset.body.byteLength !== textureAsset.asset.sizeBytes ||
      textureAsset.asset.sizeBytes < 1 || textureAsset.asset.sizeBytes > 8 * 1024 * 1024 ||
      textureAsset.asset.sha256 !== entry.sha256 || sha256(textureAsset.body) !== entry.sha256 ||
      textureMetadata.assetType !== "spritesheet-texture" || textureMetadata.companionAssetId !== atlasAssetId) {
    throw new DefineAnimationToolError("animation_atlas_texture_invalid");
  }
  const workspaceTexture = await sandbox.readBinaryFile(projectId, `public/${entry.imagePath}`, signal);
  if (!Buffer.from(workspaceTexture).equals(Buffer.from(textureAsset.body))) throw new DefineAnimationToolError("animation_atlas_texture_mismatch");
  return { atlasAssetId, sha256: stored.asset.sha256, frameNames: new Set(metadata.data.frames.map(({ frameName }) => frameName)) };
}

function parseAtlasDescriptor(value: unknown, expectedFrames: PackSpritesheetMetadata["frames"]) {
  if (!isRecord(value) || !isRecord(value.frames) || !isRecord(value.meta)) return undefined;
  const meta = value.meta;
  const size = meta.size;
  if (!isRecord(size)) return undefined;
  const width = size.w;
  const height = size.h;
  const frameNames = Object.keys(value.frames);
  const expectedFrameNames = expectedFrames.map(({ frameName }) => frameName);
  if (meta.schemaVersion !== 1 || meta.engine !== "phaser-3.90.0" || meta.atlasFormat !== "phaser-json-hash" ||
      !Array.isArray(meta.provenance) || frameNames.length !== expectedFrameNames.length ||
      frameNames.some((name) => !expectedFrameNames.includes(name)) || expectedFrameNames.some((name) => !frameNames.includes(name)) ||
      typeof meta.image !== "string" || typeof meta.sha256 !== "string" ||
      !isInteger(width) || !isInteger(height)) return undefined;
  const rectangles: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const expected of expectedFrames) {
    const candidate = value.frames[expected.frameName];
    if (!isRecord(candidate) || !isRecord(candidate.frame) || !isRecord(candidate.pivot) ||
        !isRecord(candidate.spriteSourceSize) || !isRecord(candidate.sourceSize)) return undefined;
    const rect = candidate.frame;
    if (rect.x !== expected.x || rect.y !== expected.y || rect.w !== expected.width || rect.h !== expected.height ||
        candidate.rotated !== false || candidate.trimmed !== false ||
        candidate.pivot.x !== expected.pivot.x || candidate.pivot.y !== expected.pivot.y ||
        candidate.spriteSourceSize.x !== 0 || candidate.spriteSourceSize.y !== 0 ||
        candidate.spriteSourceSize.w !== expected.width || candidate.spriteSourceSize.h !== expected.height ||
        candidate.sourceSize.w !== expected.width || candidate.sourceSize.h !== expected.height ||
        expected.x + expected.width > width || expected.y + expected.height > height) return undefined;
    rectangles.push({ x: expected.x, y: expected.y, width: expected.width, height: expected.height });
  }
  for (let leftIndex = 0; leftIndex < rectangles.length; leftIndex += 1) {
    const left = rectangles[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < rectangles.length; rightIndex += 1) {
      const right = rectangles[rightIndex]!;
      if (left.x < right.x + right.width && left.x + left.width > right.x &&
          left.y < right.y + right.height && left.y + left.height > right.y) return undefined;
    }
  }
  const provenanceNames = meta.provenance.flatMap((item) => isRecord(item) && typeof item.frameName === "string" ? [item.frameName] : []);
  if (provenanceNames.length !== expectedFrameNames.length || new Set(provenanceNames).size !== provenanceNames.length ||
      provenanceNames.some((name) => !expectedFrameNames.includes(name))) return undefined;
  return { image: meta.image, textureSha256: meta.sha256, width, height };
}

function selectAtlasMetadata(value: Record<string, unknown>): unknown {
  const keys = ["schemaVersion", "engine", "format", "atlasAssetId", "textureAssetId", "name", "atlasPath", "imagePath", "sha256", "atlasSha256", "width", "height", "paddingPixels", "extrudePixels", "frames"];
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function parseIndex(value: string | undefined): DefineAnimationManifestIndex {
  if (value === undefined) return { schemaVersion: 1, animations: [] };
  if (Buffer.byteLength(value, "utf8") > MAX_INDEX_BYTES) throw new DefineAnimationToolError("animation_index_too_large");
  try {
    const parsed = DefineAnimationManifestIndexSchema.parse(JSON.parse(value) as unknown);
    return parsed;
  } catch {
    throw new DefineAnimationToolError("animation_index_invalid");
  }
}

async function readOptionalText(sandbox: AnimationSandbox, projectId: string, path: string, signal: AbortSignal): Promise<string | undefined> {
  try { return (await sandbox.readFile(projectId, path, signal)).content; }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readRequiredText(sandbox: AnimationSandbox, projectId: string, path: string, signal: AbortSignal, code: string): Promise<string> {
  const content = await readOptionalText(sandbox, projectId, path, signal);
  if (content === undefined) throw new DefineAnimationToolError(code);
  return content;
}

async function restoreWorkspaceFile(sandbox: AnimationSandbox, projectId: string, path: string, previous: string | undefined, signal: AbortSignal) {
  if (previous === undefined) await removeWorkspaceFile(sandbox, projectId, path, signal);
  else await sandbox.writeFile(projectId, path, previous, signal).catch(() => undefined);
}

async function removeWorkspaceFile(sandbox: AnimationSandbox, projectId: string, path: string, signal: AbortSignal) {
  await sandbox.deleteFile(projectId, path, signal).catch(() => undefined);
}

function deterministicUuid(value: string): string {
  const bytes = createHmac("sha256", "forja-generated-animation-v1").update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function isSha256(value: string): boolean { return /^[a-f0-9]{64}$/.test(value); }
function isInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 4_096; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && ["file_not_found", "path_not_found"].includes(String((error as Error & { code?: unknown }).code)); }
