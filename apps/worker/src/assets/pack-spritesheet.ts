import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  GeneratedAssetMetadataSchema,
  PackSpritesheetInputSchema,
  PackSpritesheetManifestSchema,
  PackSpritesheetMetadataSchema,
  PackSpritesheetResultSchema,
  GENERATED_ASSET_MAX_BYTES,
  GENERATED_ASSET_MAX_PIXELS,
  type PackSpritesheetMetadata,
  type PackSpritesheetResult,
} from "@meta-game/contracts";
import { OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import type { SandboxControllerClient } from "@meta-game/sandbox";
import type { StorageAsset } from "@meta-game/storage";
import { loadRuntimeManifest, MAX_PROJECT_GENERATED_ASSETS, type RuntimeGeneratedAssetManifest } from "./image-generator";
import { inspectAsset, type AssetInspectionSource } from "./inspect-asset";

export const GENERATED_SPRITESHEET_MANIFEST_PATH = "public/assets/generated/atlases/manifest.json";
const SPRITESHEET_DIRECTORY = "assets/generated/atlases";
const MAX_SPRITESHEET_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_PIVOT = { x: 0.5, y: 1 };

type SourceAsset = Pick<StorageAsset, "id" | "projectId" | "contentType" | "sizeBytes" | "sha256" | "metadata">;
export interface SpritesheetStorage {
  read(identity: VerifiedIdentityContext, assetId: string): Promise<{ asset: SourceAsset; body: Uint8Array }>;
  upload(identity: VerifiedIdentityContext, request: {
    assetId?: string;
    projectId: string;
    contentType: "image/png" | "application/json";
    body: Uint8Array;
    metadata: Record<string, unknown>;
  }): Promise<Pick<StorageAsset, "id" | "sha256" | "status"> & { created?: boolean }>;
  delete(identity: VerifiedIdentityContext, assetId: string): Promise<void>;
}

type SpritesheetSandbox = Pick<SandboxControllerClient, "readFile" | "readBinaryFile" | "writeFile" | "writeBinaryFile" | "deleteFile">;
export type PackSpritesheetToolContext = Readonly<{
  claim: RunWorkerClaim;
  callId: string;
  projectId: string;
  signal: AbortSignal;
}>;

export class SpritesheetToolError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SpritesheetToolError";
  }
}

type StoredFrameSource = Readonly<{
  assetId: string;
  sha256: string;
  body: Buffer;
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
}>;
type PackedFrame = Readonly<{
  frameName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pivot: { x: number; y: number };
  sourceAssetId: string;
  sourceFrameIndex: number;
  sourceSha256: string;
  pixels: Buffer;
}>;
type Rectangle = Readonly<{ x: number; y: number; width: number; height: number }>;
type ManifestEntry = Readonly<{
  atlasAssetId: string;
  textureAssetId: string;
  name: string;
  atlasPath: string;
  imagePath: string;
  sha256: string;
  requestSha256: string;
  width: number;
  height: number;
  frameCount: number;
}>;

export function createPackSpritesheetTool(input: {
  storage: SpritesheetStorage;
  sandbox: SpritesheetSandbox;
  identity(claim: RunWorkerClaim): Promise<VerifiedIdentityContext>;
}) {
  return async function packSpritesheetTool(
    rawInput: Record<string, unknown>,
    context: PackSpritesheetToolContext,
  ): Promise<PackSpritesheetResult> {
    const parsed = PackSpritesheetInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new Error("agent_invalid_tool_arguments");
    if (context.projectId !== context.claim.projectId || !context.callId || context.callId.length > 200) {
      throw new OwnedResourceNotFoundError();
    }
    context.signal.throwIfAborted();

    const request = parsed.data;
    const runtimeManifest = await loadRuntimeManifest(input.sandbox, context.projectId, context.signal);
    const identity = await input.identity(context.claim);
    if (identity.userId !== context.claim.ownerUserId) throw new OwnedResourceNotFoundError();
    const sourceCache = new Map<string, StoredFrameSource>();
    const frames: PackedFrame[] = [];
    for (const requestedFrame of request.frames) {
      context.signal.throwIfAborted();
      let source = sourceCache.get(requestedFrame.sourceAssetId);
      if (!source) {
        source = await loadSource(input.storage, identity, context.projectId, runtimeManifest, requestedFrame.sourceAssetId, context.signal);
        sourceCache.set(requestedFrame.sourceAssetId, source);
      }
      if (requestedFrame.sourceFrameIndex >= source.columns * source.rows) {
        throw new SpritesheetToolError("spritesheet_source_frame_out_of_range");
      }
      const left = (requestedFrame.sourceFrameIndex % source.columns) * source.frameWidth;
      const top = Math.floor(requestedFrame.sourceFrameIndex / source.columns) * source.frameHeight;
      let pixels: Buffer;
      try {
        pixels = await sharp(source.body, { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS, sequentialRead: true })
          .extract({ left, top, width: source.frameWidth, height: source.frameHeight })
          .ensureAlpha()
          .raw()
          .toBuffer();
      } catch {
        throw new SpritesheetToolError("spritesheet_source_frame_invalid");
      }
      if (pixels.byteLength !== source.frameWidth * source.frameHeight * 4) {
        throw new SpritesheetToolError("spritesheet_source_frame_invalid");
      }
      frames.push({
        frameName: requestedFrame.frameName,
        x: 0,
        y: 0,
        width: source.frameWidth,
        height: source.frameHeight,
        pivot: DEFAULT_PIVOT,
        sourceAssetId: source.assetId,
        sourceFrameIndex: requestedFrame.sourceFrameIndex,
        sourceSha256: source.sha256,
        pixels,
      });
    }

    const packed = packShelves(frames, request.paddingPixels, request.extrudePixels, request.maxTextureSize);
    const textureBytes = await encodeTexture(packed.pixels, packed.width, packed.height);
    const textureSha256 = sha256(textureBytes);
    const atlasAssetId = deterministicUuid(context.claim.runId + "\0" + context.callId + "\0spritesheet-atlas");
    const textureAssetId = deterministicUuid(context.claim.runId + "\0" + context.callId + "\0spritesheet-texture");
    const atlasPath = SPRITESHEET_DIRECTORY + "/" + atlasAssetId + ".json";
    const imagePath = SPRITESHEET_DIRECTORY + "/" + textureAssetId + ".png";
    const publicAtlasPath = "public/" + atlasPath;
    const publicImagePath = "public/" + imagePath;
    const requestSha256 = sha256(Buffer.from(canonicalJson(request), "utf8"));
    const atlas = {
      frames: Object.fromEntries(packed.frames.map((frame) => [frame.frameName, {
        frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: frame.width, h: frame.height },
        sourceSize: { w: frame.width, h: frame.height },
        pivot: frame.pivot,
      }])),
      meta: {
        app: "Forja",
        version: "1.0",
        image: textureAssetId + ".png",
        size: { w: packed.width, h: packed.height },
        format: "RGBA8888",
        scale: "1",
        schemaVersion: 1,
        engine: "phaser-3.90.0",
        atlasFormat: "phaser-json-hash",
        sha256: textureSha256,
        paddingPixels: request.paddingPixels,
        extrudePixels: request.extrudePixels,
        provenance: packed.frames.map(({ frameName, sourceAssetId, sourceFrameIndex, sourceSha256 }) => ({
          frameName, sourceAssetId, sourceFrameIndex, sourceSha256,
        })),
      },
    };
    const atlasBytes = Buffer.from(JSON.stringify(atlas, null, 2) + "\n", "utf8");
    const atlasSha256 = sha256(atlasBytes);
    const resultFrames = packed.frames.map(({ frameName, x, y, width, height }) => ({ frameName, x, y, width, height }));
    const metadata: PackSpritesheetMetadata = PackSpritesheetMetadataSchema.parse({
      schemaVersion: 1,
      engine: "phaser-3.90.0",
      format: "phaser-json-hash",
      atlasAssetId,
      textureAssetId,
      name: request.name,
      atlasPath,
      imagePath,
      sha256: textureSha256,
      atlasSha256,
      width: packed.width,
      height: packed.height,
      paddingPixels: request.paddingPixels,
      extrudePixels: request.extrudePixels,
      frames: packed.frames.map(({ frameName, x, y, width, height, pivot, sourceAssetId, sourceFrameIndex, sourceSha256 }) => ({
        frameName, x, y, width, height, pivot, sourceAssetId, sourceFrameIndex, sourceSha256,
      })),
    });
    const result = PackSpritesheetResultSchema.parse({
      atlasAssetId, textureAssetId, atlasPath, imagePath, sha256: textureSha256,
      width: packed.width, height: packed.height, format: "phaser-json-hash", frames: resultFrames,
    });

    const oldManifestText = await readOptionalText(input.sandbox, context.projectId, GENERATED_SPRITESHEET_MANIFEST_PATH, context.signal);
    const manifest = parseManifest(oldManifestText);
    const existingById = manifest.spritesheets.find((entry) => entry.atlasAssetId === atlasAssetId);
    const existingByName = manifest.spritesheets.find((entry) => entry.name === request.name);
    if (existingByName && existingByName.atlasAssetId !== atlasAssetId) throw new SpritesheetToolError("spritesheet_name_conflict");
    const manifestEntry: ManifestEntry = {
      atlasAssetId, textureAssetId, name: request.name, atlasPath, imagePath, sha256: textureSha256,
      requestSha256, width: packed.width, height: packed.height, frameCount: packed.frames.length,
    };
    if (existingById && JSON.stringify(existingById) !== JSON.stringify(manifestEntry)) {
      throw new SpritesheetToolError("spritesheet_idempotency_conflict");
    }
    const updatedManifestText = JSON.stringify({
      schemaVersion: 1,
      spritesheets: existingById ? manifest.spritesheets : manifest.spritesheets.concat(manifestEntry),
    }, null, 2) + "\n";
    if (Buffer.byteLength(updatedManifestText, "utf8") > MAX_SPRITESHEET_MANIFEST_BYTES) throw new SpritesheetToolError("spritesheet_manifest_too_large");
    if (!existingById && manifest.spritesheets.length >= MAX_PROJECT_GENERATED_ASSETS) throw new SpritesheetToolError("spritesheet_manifest_limit");

    await assertWorkspaceBinary(input.sandbox, context.projectId, publicImagePath, textureBytes, context.signal);
    await assertWorkspaceText(input.sandbox, context.projectId, publicAtlasPath, atlasBytes.toString("utf8"), context.signal);
    const createdObjects: string[] = [];
    let imageWriteAttempted = false;
    let atlasWriteAttempted = false;
    let manifestWriteAttempted = false;
    try {
      context.signal.throwIfAborted();
      const storedTexture = await input.storage.upload(identity, {
        assetId: textureAssetId,
        projectId: context.projectId,
        contentType: "image/png",
        body: textureBytes,
        metadata: { ...metadata, assetType: "spritesheet-texture", companionAssetId: atlasAssetId, companionAssetType: "spritesheet-atlas" },
      });
      if (storedTexture.id === textureAssetId && storedTexture.created !== false) createdObjects.push(storedTexture.id);
      if (storedTexture.id !== textureAssetId || storedTexture.status !== "ready" || storedTexture.sha256 !== textureSha256) {
        throw new SpritesheetToolError("spritesheet_texture_storage_failed");
      }

      context.signal.throwIfAborted();
      const storedAtlas = await input.storage.upload(identity, {
        assetId: atlasAssetId,
        projectId: context.projectId,
        contentType: "application/json",
        body: atlasBytes,
        metadata: { ...metadata, assetType: "spritesheet-atlas", companionAssetId: textureAssetId, companionAssetType: "spritesheet-texture" },
      });
      if (storedAtlas.id === atlasAssetId && storedAtlas.created !== false) createdObjects.push(storedAtlas.id);
      if (storedAtlas.id !== atlasAssetId || storedAtlas.status !== "ready" || storedAtlas.sha256 !== atlasSha256) {
        throw new SpritesheetToolError("spritesheet_atlas_storage_failed");
      }

      if (await readOptionalBinary(input.sandbox, context.projectId, publicImagePath, context.signal) === undefined) {
        imageWriteAttempted = true;
        const written = await input.sandbox.writeBinaryFile(context.projectId, publicImagePath, textureBytes, context.signal);
        if (written.bytesWritten !== textureBytes.byteLength) throw new SpritesheetToolError("spritesheet_workspace_image_write_failed");
      }
      context.signal.throwIfAborted();
      if (await readOptionalText(input.sandbox, context.projectId, publicAtlasPath, context.signal) === undefined) {
        atlasWriteAttempted = true;
        const written = await input.sandbox.writeFile(context.projectId, publicAtlasPath, atlasBytes.toString("utf8"), context.signal);
        if (written.bytesWritten !== atlasBytes.byteLength) throw new SpritesheetToolError("spritesheet_workspace_atlas_write_failed");
      }
      if (!existingById) {
        manifestWriteAttempted = true;
        const written = await input.sandbox.writeFile(context.projectId, GENERATED_SPRITESHEET_MANIFEST_PATH, updatedManifestText, context.signal);
        if (written.bytesWritten !== Buffer.byteLength(updatedManifestText, "utf8")) throw new SpritesheetToolError("spritesheet_workspace_manifest_write_failed");
      }
      context.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (manifestWriteAttempted) await restoreWorkspaceFile(input.sandbox, context.projectId, GENERATED_SPRITESHEET_MANIFEST_PATH, oldManifestText);
      if (atlasWriteAttempted) await removeWorkspaceFile(input.sandbox, context.projectId, publicAtlasPath);
      if (imageWriteAttempted) await removeWorkspaceFile(input.sandbox, context.projectId, publicImagePath);
      for (const assetId of createdObjects.reverse()) await input.storage.delete(identity, assetId).catch(() => undefined);
      throw error;
    }
  };
}

async function loadSource(
  storage: SpritesheetStorage,
  identity: VerifiedIdentityContext,
  projectId: string,
  manifest: RuntimeGeneratedAssetManifest,
  assetId: string,
  signal: AbortSignal,
): Promise<StoredFrameSource> {
  const entry = manifest.assets.find((asset) => asset.assetId === assetId);
  if (!entry) throw new OwnedResourceNotFoundError();
  let stored: Awaited<ReturnType<SpritesheetStorage["read"]>>;
  try {
    stored = await storage.read(identity, assetId);
  } catch (error) {
    if (error instanceof OwnedResourceNotFoundError) throw error;
    throw new SpritesheetToolError("spritesheet_source_unavailable");
  }
  if (stored.asset.id !== assetId || stored.asset.projectId !== projectId) throw new OwnedResourceNotFoundError();
  if (stored.asset.contentType !== "image/png" || stored.asset.sizeBytes < 1 || stored.asset.sizeBytes > GENERATED_ASSET_MAX_BYTES ||
      stored.body.byteLength !== stored.asset.sizeBytes || !/^[a-f0-9]{64}$/.test(stored.asset.sha256) || sha256(stored.body) !== stored.asset.sha256) {
    throw new SpritesheetToolError("spritesheet_source_integrity_invalid");
  }

  const inspectionSource: AssetInspectionSource = {
    readWorkspaceText: async () => { throw new Error("file_not_found"); },
    readWorkspaceBinary: async () => { throw new Error("file_not_found"); },
    readStoredAsset: async (sourceId) => {
      if (sourceId !== assetId) throw new OwnedResourceNotFoundError();
      return stored;
    },
  };
  const inspection = await inspectAsset({ assetId, kind: "image", checks: ["decode", "dimensions", "frame-grid"] }, inspectionSource, signal);
  if (inspection.status !== "valid" || !inspection.dimensions) throw new SpritesheetToolError("spritesheet_source_inspection_failed");

  const metadata = GeneratedAssetMetadataSchema.safeParse(stored.asset.metadata);
  if (!metadata.success || metadata.data.mimeType !== "image/png" || metadata.data.sha256 !== stored.asset.sha256 ||
      metadata.data.width !== entry.frameColumns * entry.frameWidth || metadata.data.height !== entry.frameRows * entry.frameHeight ||
      metadata.data.frames.columns !== entry.frameColumns || metadata.data.frames.rows !== entry.frameRows ||
      metadata.data.frames.frameWidth !== entry.frameWidth || metadata.data.frames.frameHeight !== entry.frameHeight ||
      entry.frameColumns * entry.frameRows > 64 || inspection.dimensions.width !== metadata.data.width || inspection.dimensions.height !== metadata.data.height) {
    throw new SpritesheetToolError("spritesheet_source_metadata_invalid");
  }

  let decoded;
  try {
    decoded = await sharp(stored.body, { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS, sequentialRead: true }).metadata();
  } catch {
    throw new SpritesheetToolError("spritesheet_source_image_invalid");
  }
  if (decoded.format !== "png" || decoded.width !== metadata.data.width || decoded.height !== metadata.data.height ||
      decoded.width !== entry.frameColumns * entry.frameWidth || decoded.height !== entry.frameRows * entry.frameHeight ||
      decoded.width > 2_048 || decoded.height > 2_048 || (decoded.pages ?? 1) !== 1) {
    throw new SpritesheetToolError("spritesheet_source_image_metadata_mismatch");
  }
  return {
    assetId, sha256: stored.asset.sha256, body: Buffer.from(stored.body),
    columns: entry.frameColumns, rows: entry.frameRows, frameWidth: entry.frameWidth, frameHeight: entry.frameHeight,
  };
}

function packShelves(frames: readonly PackedFrame[], padding: number, extrude: number, maxTextureSize: number) {
  const blocks = frames.map((frame) => ({ width: frame.width + extrude * 2, height: frame.height + extrude * 2 }));
  const widest = Math.max(...blocks.map(({ width }) => width));
  const area = blocks.reduce((total, block) => total + (block.width + padding) * (block.height + padding), 0);
  const primaryLimit = Math.min(maxTextureSize, Math.max(widest, Math.ceil(Math.sqrt(area))));
  const layout = layoutShelves(blocks, padding, primaryLimit, maxTextureSize) ??
    (primaryLimit === maxTextureSize ? undefined : layoutShelves(blocks, padding, maxTextureSize, maxTextureSize));
  if (!layout) throw new SpritesheetToolError("spritesheet_texture_limit_exceeded");
  if (layout.width * layout.height > GENERATED_ASSET_MAX_PIXELS) throw new SpritesheetToolError("spritesheet_pixel_limit_exceeded");
  const pixels = Buffer.alloc(layout.width * layout.height * 4);
  const placedFrames: PackedFrame[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const block = layout.rectangles[index]!;
    blitFrame(pixels, layout.width, frame, block, extrude);
    placedFrames.push({ ...frame, x: block.x + extrude, y: block.y + extrude });
  }
  return { frames: placedFrames, width: layout.width, height: layout.height, pixels };
}

function layoutShelves(
  blocks: readonly { width: number; height: number }[],
  padding: number,
  targetWidth: number,
  maxTextureSize: number,
): { rectangles: Rectangle[]; width: number; height: number } | undefined {
  const rectangles: Rectangle[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let usedWidth = 0;
  for (const block of blocks) {
    if (block.width > targetWidth || block.height > maxTextureSize) return undefined;
    let candidateX = x === 0 ? 0 : x + padding;
    if (candidateX + block.width > targetWidth) {
      y += rowHeight + padding;
      x = 0;
      rowHeight = 0;
      candidateX = 0;
    }
    if (y + block.height > maxTextureSize) return undefined;
    rectangles.push({ x: candidateX, y, width: block.width, height: block.height });
    x = candidateX + block.width;
    rowHeight = Math.max(rowHeight, block.height);
    usedWidth = Math.max(usedWidth, x);
  }
  const height = y + rowHeight;
  if (usedWidth < 1 || height < 1) return undefined;
  return { rectangles, width: usedWidth, height };
}

function blitFrame(destination: Buffer, destinationWidth: number, frame: PackedFrame, block: Rectangle, extrude: number): void {
  for (let y = -extrude; y < frame.height + extrude; y += 1) {
    const sourceY = Math.max(0, Math.min(frame.height - 1, y));
    for (let x = -extrude; x < frame.width + extrude; x += 1) {
      const sourceX = Math.max(0, Math.min(frame.width - 1, x));
      const sourceOffset = (sourceY * frame.width + sourceX) * 4;
      const targetX = block.x + extrude + x;
      const targetY = block.y + extrude + y;
      const targetOffset = (targetY * destinationWidth + targetX) * 4;
      frame.pixels.copy(destination, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
}

async function encodeTexture(raw: Buffer, width: number, height: number): Promise<Buffer> {
  if (width < 1 || height < 1 || width > 4_096 || height > 4_096 || width * height > GENERATED_ASSET_MAX_PIXELS || raw.byteLength !== width * height * 4) {
    throw new SpritesheetToolError("spritesheet_dimensions_invalid");
  }
  let result: Buffer;
  try {
    result = await sharp(raw, { raw: { width, height, channels: 4 }, limitInputPixels: GENERATED_ASSET_MAX_PIXELS })
      .png({ compressionLevel: 9, adaptiveFiltering: false, force: true })
      .toBuffer();
  } catch {
    throw new SpritesheetToolError("spritesheet_png_encode_failed");
  }
  if (result.byteLength < 1 || result.byteLength > GENERATED_ASSET_MAX_BYTES) throw new SpritesheetToolError("spritesheet_png_size_invalid");
  return result;
}

function parseManifest(text: string | undefined): { schemaVersion: 1; spritesheets: ManifestEntry[] } {
  if (text === undefined) return PackSpritesheetManifestSchema.parse({ schemaVersion: 1, spritesheets: [] });
  if (Buffer.byteLength(text, "utf8") > MAX_SPRITESHEET_MANIFEST_BYTES) throw new SpritesheetToolError("spritesheet_manifest_too_large");
  try {
    return PackSpritesheetManifestSchema.parse(JSON.parse(text) as unknown);
  } catch {
    throw new SpritesheetToolError("spritesheet_manifest_invalid");
  }
}

async function assertWorkspaceBinary(sandbox: SpritesheetSandbox, projectId: string, path: string, expected: Uint8Array, signal: AbortSignal): Promise<void> {
  const existing = await readOptionalBinary(sandbox, projectId, path, signal);
  if (existing && !Buffer.from(existing).equals(Buffer.from(expected))) throw new SpritesheetToolError("spritesheet_workspace_path_conflict");
}

async function assertWorkspaceText(sandbox: SpritesheetSandbox, projectId: string, path: string, expected: string, signal: AbortSignal): Promise<void> {
  const existing = await readOptionalText(sandbox, projectId, path, signal);
  if (existing !== undefined && existing !== expected) throw new SpritesheetToolError("spritesheet_workspace_path_conflict");
}

async function readOptionalBinary(sandbox: SpritesheetSandbox, projectId: string, path: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
  try {
    return await sandbox.readBinaryFile(projectId, path, signal);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw new SpritesheetToolError("spritesheet_workspace_read_failed");
  }
}

async function readOptionalText(sandbox: SpritesheetSandbox, projectId: string, path: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    return (await sandbox.readFile(projectId, path, signal)).content;
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw new SpritesheetToolError("spritesheet_workspace_read_failed");
  }
}

async function restoreWorkspaceFile(sandbox: SpritesheetSandbox, projectId: string, path: string, previous: string | undefined): Promise<void> {
  if (previous === undefined) await removeWorkspaceFile(sandbox, projectId, path);
  else await sandbox.writeFile(projectId, path, previous).catch(() => undefined);
}

async function removeWorkspaceFile(sandbox: SpritesheetSandbox, projectId: string, path: string): Promise<void> {
  await sandbox.deleteFile(projectId, path).catch(() => undefined);
}

function isMissingPath(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "file_not_found" || code === "path_not_found";
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
