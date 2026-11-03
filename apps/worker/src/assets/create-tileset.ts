import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  CreateTilesetInputSchema,
  CreateTilesetManifestSchema,
  CreateTilesetMetadataSchema,
  CreateTilesetResultSchema,
  GeneratedAssetMetadataSchema,
  type CreateTilesetInput,
  type CreateTilesetManifest,
  type CreateTilesetResult,
  GENERATED_ASSET_MAX_BYTES,
  GENERATED_ASSET_MAX_PIXELS,
} from "@meta-game/contracts";
import { OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import type { SandboxControllerClient } from "@meta-game/sandbox";
import type { StorageAsset } from "@meta-game/storage";
import {
  MAX_PROJECT_GENERATED_ASSETS,
  loadRuntimeManifest,
  type RuntimeGeneratedAssetManifest,
} from "./image-generator";

export const GENERATED_TILESET_MANIFEST_PATH = "public/assets/generated/tilesets/manifest.json";
const MAX_TILESET_MANIFEST_BYTES = 256 * 1024;
const TILESET_ASSET_DIR = "assets/generated/tilesets";

type StoredImage = Readonly<{
  assetId: string;
  sha256: string;
  body: Buffer;
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
}>;

export class TilesetToolError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TilesetToolError";
  }
}

export interface TilesetStorage {
  read(identity: VerifiedIdentityContext, assetId: string): Promise<{
    asset: Pick<StorageAsset, "id" | "projectId" | "contentType" | "sizeBytes" | "sha256" | "metadata">;
    body: Uint8Array;
  }>;
  upload(identity: VerifiedIdentityContext, request: {
    assetId?: string;
    projectId: string;
    contentType: "image/png" | "application/json";
    body: Uint8Array;
    metadata: Record<string, unknown>;
  }): Promise<Pick<StorageAsset, "id" | "sha256" | "status"> & { created?: boolean }>;
  delete(identity: VerifiedIdentityContext, assetId: string): Promise<void>;
}

type TilesetSandbox = Pick<SandboxControllerClient,
  "readFile" | "readBinaryFile" | "writeFile" | "writeBinaryFile" | "deleteFile">;

export type CreateTilesetToolContext = Readonly<{
  claim: RunWorkerClaim;
  callId: string;
  projectId: string;
  signal: AbortSignal;
}>;

export function createCreateTilesetTool(input: {
  storage: TilesetStorage;
  sandbox: TilesetSandbox;
  identity(claim: RunWorkerClaim): Promise<VerifiedIdentityContext>;
}) {
  return async function createTilesetTool(rawInput: Record<string, unknown>, context: CreateTilesetToolContext): Promise<CreateTilesetResult> {
    const parsed = CreateTilesetInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new Error("agent_invalid_tool_arguments");
    if (context.projectId !== context.claim.projectId || !context.callId || context.callId.length > 200) {
      throw new OwnedResourceNotFoundError();
    }

    const request = parsed.data;
    const columns = request.columns ?? Math.min(16, request.tiles.length);
    const rows = Math.ceil(request.tiles.length / columns);
    if (rows < 1 || rows > 16) throw new TilesetToolError("tileset_grid_out_of_range");
    const runtimeManifest = await loadRuntimeManifest(input.sandbox, context.projectId, context.signal);
    const identity = await input.identity(context.claim);
    const packed = await packTiles(input.storage, identity, context.projectId, runtimeManifest, request, columns, rows);
    const imageBytes = await encodeAtlas(packed.raw, request.tileSize * columns, request.tileSize * rows);
    if (imageBytes.byteLength < 1 || imageBytes.byteLength > GENERATED_ASSET_MAX_BYTES) {
      throw new TilesetToolError("tileset_image_size_invalid");
    }

    const tilesetAssetId = deterministicUuid(`${context.claim.runId}\0${context.callId}\0tileset-image`);
    const metadataAssetId = deterministicUuid(`${context.claim.runId}\0${context.callId}\0tileset-metadata`);
    const imagePath = `${TILESET_ASSET_DIR}/${tilesetAssetId}.png`;
    const metadataPath = `${TILESET_ASSET_DIR}/${tilesetAssetId}.json`;
    const imageWorkspacePath = `public/${imagePath}`;
    const metadataWorkspacePath = `public/${metadataPath}`;
    const imageSha256 = sha256(imageBytes);
    const tiles = request.tiles.map((tile, tileIndex) => ({
      tileIndex,
      tileName: tile.tileName,
      collides: tile.collides,
      terrain: tile.terrain ?? "unknown" as const,
    }));
    const metadata = CreateTilesetMetadataSchema.parse({
      schemaVersion: 1,
      engine: "phaser-3.90.0",
      tilesetAssetId,
      name: request.name,
      image: `${tilesetAssetId}.png`,
      imagePath,
      metadataPath,
      sha256: imageSha256,
      tileSize: request.tileSize,
      tilewidth: request.tileSize,
      tileheight: request.tileSize,
      columns,
      rows,
      tilecount: tiles.length,
      margin: 0,
      spacing: 0,
      width: request.tileSize * columns,
      height: request.tileSize * rows,
      layout: "input-order-row-major",
      tiles: tiles.map((tile) => ({
        id: tile.tileIndex,
        type: tile.tileName,
        ...tile,
      })),
    });
    const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    const result = CreateTilesetResultSchema.parse({
      tilesetAssetId,
      name: request.name,
      imagePath,
      metadataPath,
      sha256: imageSha256,
      tileSize: request.tileSize,
      columns,
      rows,
      tiles,
    });

    const oldManifestText = await readOptionalText(input.sandbox, context.projectId, GENERATED_TILESET_MANIFEST_PATH, context.signal);
    let manifest: CreateTilesetManifest;
    try {
      manifest = oldManifestText === undefined
        ? { schemaVersion: 1, tilesets: [] }
        : CreateTilesetManifestSchema.parse(JSON.parse(oldManifestText) as unknown);
    } catch {
      throw new TilesetToolError("tileset_manifest_invalid");
    }
    const existingById = manifest.tilesets.find((entry) => entry.tilesetAssetId === tilesetAssetId);
    const existingByName = manifest.tilesets.find((entry) => entry.name === request.name);
    if (existingByName && existingByName.tilesetAssetId !== tilesetAssetId) {
      throw new TilesetToolError("tileset_name_conflict");
    }
    const manifestEntry = {
      tilesetAssetId,
      name: request.name,
      imagePath,
      metadataPath,
      sha256: imageSha256,
      tileSize: request.tileSize,
      columns,
      rows,
      tileCount: request.tiles.length,
    };
    if (existingById && JSON.stringify(existingById) !== JSON.stringify(manifestEntry)) {
      throw new TilesetToolError("tileset_idempotency_conflict");
    }
    const updatedManifest = CreateTilesetManifestSchema.parse({
      schemaVersion: 1,
      tilesets: existingById ? manifest.tilesets : [...manifest.tilesets, manifestEntry],
    });
    const updatedManifestText = `${JSON.stringify(updatedManifest, null, 2)}\n`;
    if (Buffer.byteLength(updatedManifestText, "utf8") > MAX_TILESET_MANIFEST_BYTES) {
      throw new TilesetToolError("tileset_manifest_too_large");
    }
    if (!existingById && updatedManifest.tilesets.length > MAX_PROJECT_GENERATED_ASSETS) {
      throw new TilesetToolError("tileset_manifest_limit");
    }

    await assertWorkspaceOutput(input.sandbox, context.projectId, imageWorkspacePath, imageBytes, context.signal);
    await assertWorkspaceTextOutput(input.sandbox, context.projectId, metadataWorkspacePath, metadataBytes.toString("utf8"), context.signal);

    const uploaded: Array<{ id: string; created: boolean }> = [];
    let imageWriteAttempted = false;
    let metadataWriteAttempted = false;
    let manifestWriteAttempted = false;
    try {
      const imageAsset = await input.storage.upload(identity, {
        assetId: tilesetAssetId,
        projectId: context.projectId,
        contentType: "image/png",
        body: imageBytes,
        metadata: {
          schemaVersion: 1,
          assetType: "tileset-image",
          tilesetAssetId,
          metadataAssetId,
          name: request.name,
          sha256: imageSha256,
          imagePath,
          metadataPath,
          tileCount: tiles.length,
        },
      });
      if (imageAsset.id === tilesetAssetId) uploaded.push({ id: imageAsset.id, created: imageAsset.created !== false });
      if (imageAsset.status !== "ready" || imageAsset.id !== tilesetAssetId || imageAsset.sha256 !== imageSha256) {
        throw new TilesetToolError("tileset_image_storage_failed");
      }

      const metadataAsset = await input.storage.upload(identity, {
        assetId: metadataAssetId,
        projectId: context.projectId,
        contentType: "application/json",
        body: metadataBytes,
        metadata: {
          schemaVersion: 1,
          assetType: "tileset-metadata",
          tilesetAssetId,
          metadataAssetId,
          sha256: sha256(metadataBytes),
          imageSha256,
          metadataPath,
        },
      });
      if (metadataAsset.id === metadataAssetId) uploaded.push({ id: metadataAsset.id, created: metadataAsset.created !== false });
      if (metadataAsset.status !== "ready" || metadataAsset.id !== metadataAssetId || metadataAsset.sha256 !== sha256(metadataBytes)) {
        throw new TilesetToolError("tileset_metadata_storage_failed");
      }

      const oldImage = await readOptionalBinary(input.sandbox, context.projectId, imageWorkspacePath, context.signal);
      if (!oldImage) {
        imageWriteAttempted = true;
        try {
          const written = await input.sandbox.writeBinaryFile(context.projectId, imageWorkspacePath, imageBytes, context.signal);
          if (written.bytesWritten !== imageBytes.byteLength) throw new Error("short_write");
        } catch {
          throw new TilesetToolError("tileset_workspace_image_write_failed");
        }
      }
      const oldMetadata = await readOptionalText(input.sandbox, context.projectId, metadataWorkspacePath, context.signal);
      if (oldMetadata === undefined) {
        metadataWriteAttempted = true;
        try {
          const written = await input.sandbox.writeFile(context.projectId, metadataWorkspacePath, metadataBytes.toString("utf8"), context.signal);
          if (written.bytesWritten !== metadataBytes.byteLength) throw new Error("short_write");
        } catch {
          throw new TilesetToolError("tileset_workspace_metadata_write_failed");
        }
      }
      if (!existingById) {
        manifestWriteAttempted = true;
        try {
          const written = await input.sandbox.writeFile(context.projectId, GENERATED_TILESET_MANIFEST_PATH, updatedManifestText, context.signal);
          if (written.bytesWritten !== Buffer.byteLength(updatedManifestText, "utf8")) throw new Error("short_write");
        } catch {
          throw new TilesetToolError("tileset_workspace_manifest_write_failed");
        }
      }
      return result;
    } catch (error) {
      if (manifestWriteAttempted) await restoreWorkspaceFile(input.sandbox, context.projectId, GENERATED_TILESET_MANIFEST_PATH, oldManifestText, context.signal);
      if (metadataWriteAttempted) await removeWorkspaceFile(input.sandbox, context.projectId, metadataWorkspacePath, context.signal);
      if (imageWriteAttempted) await removeWorkspaceFile(input.sandbox, context.projectId, imageWorkspacePath, context.signal);
      for (const entry of uploaded.reverse()) {
        if (entry.created) await input.storage.delete(identity, entry.id).catch(() => undefined);
      }
      throw error;
    }
  };
}

async function packTiles(
  storage: TilesetStorage,
  identity: VerifiedIdentityContext,
  projectId: string,
  manifest: RuntimeGeneratedAssetManifest,
  request: CreateTilesetInput,
  columns: number,
  rows: number,
): Promise<{ raw: Buffer }> {
  const output = Buffer.alloc(request.tileSize * columns * request.tileSize * rows * 4);
  const cache = new Map<string, StoredImage>();
  for (const [tileIndex, tile] of request.tiles.entries()) {
    let source = cache.get(tile.sourceAssetId);
    if (!source) {
      source = await loadSource(storage, identity, projectId, manifest, tile.sourceAssetId);
      cache.set(tile.sourceAssetId, source);
    }
    const frameCount = source.columns * source.rows;
    if (!Number.isInteger(tile.sourceFrameIndex) || tile.sourceFrameIndex < 0 || tile.sourceFrameIndex >= frameCount) {
      throw new TilesetToolError("tileset_source_frame_out_of_range");
    }
    if (source.frameWidth !== request.tileSize || source.frameHeight !== request.tileSize) {
      throw new TilesetToolError("tileset_source_size_mismatch");
    }
    let pixels: Buffer;
    try {
      const left = (tile.sourceFrameIndex % source.columns) * source.frameWidth;
      const top = Math.floor(tile.sourceFrameIndex / source.columns) * source.frameHeight;
      pixels = await sharp(source.body, { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS })
        .extract({ left, top, width: source.frameWidth, height: source.frameHeight })
        .ensureAlpha()
        .raw()
        .toBuffer();
    } catch {
      throw new TilesetToolError("tileset_source_frame_invalid");
    }
    if (pixels.byteLength !== request.tileSize * request.tileSize * 4) throw new TilesetToolError("tileset_source_frame_invalid");
    const destinationX = (tileIndex % columns) * request.tileSize;
    const destinationY = Math.floor(tileIndex / columns) * request.tileSize;
    for (let row = 0; row < request.tileSize; row += 1) {
      const sourceStart = row * request.tileSize * 4;
      const targetStart = ((destinationY + row) * request.tileSize * columns + destinationX) * 4;
      pixels.copy(output, targetStart, sourceStart, sourceStart + request.tileSize * 4);
    }
  }
  return { raw: output };
}

async function loadSource(
  storage: TilesetStorage,
  identity: VerifiedIdentityContext,
  projectId: string,
  manifest: RuntimeGeneratedAssetManifest,
  assetId: string,
): Promise<StoredImage> {
  const entry = manifest.assets.find((asset) => asset.assetId === assetId);
  if (!entry) throw new OwnedResourceNotFoundError();
  let stored: Awaited<ReturnType<TilesetStorage["read"]>>;
  try {
    stored = await storage.read(identity, assetId);
  } catch (error) {
    if (error instanceof OwnedResourceNotFoundError) throw error;
    throw new TilesetToolError("tileset_source_unavailable");
  }
  if (stored.asset.id !== assetId || stored.asset.projectId !== projectId) throw new OwnedResourceNotFoundError();
  const size = stored.asset.sizeBytes;
  if (stored.asset.contentType !== "image/png" || size < 1 || size > GENERATED_ASSET_MAX_BYTES ||
      stored.body.byteLength !== size || !/^[a-f0-9]{64}$/.test(stored.asset.sha256) || sha256(stored.body) !== stored.asset.sha256) {
    throw new TilesetToolError("tileset_source_integrity_invalid");
  }
  const metadata = GeneratedAssetMetadataSchema.safeParse(stored.asset.metadata);
  if (!metadata.success || metadata.data.mimeType !== "image/png" || metadata.data.sha256 !== stored.asset.sha256 ||
      metadata.data.width !== entry.frameColumns * entry.frameWidth || metadata.data.height !== entry.frameRows * entry.frameHeight ||
      metadata.data.frames.columns !== entry.frameColumns || metadata.data.frames.rows !== entry.frameRows ||
      metadata.data.frames.frameWidth !== entry.frameWidth || metadata.data.frames.frameHeight !== entry.frameHeight ||
      entry.frameColumns * entry.frameRows > 64) {
    throw new TilesetToolError("tileset_source_metadata_invalid");
  }
  let decoded;
  try {
    decoded = await sharp(stored.body, { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS }).metadata();
  } catch {
    throw new TilesetToolError("tileset_source_image_invalid");
  }
  if (decoded.format !== "png" || decoded.width !== metadata.data.width || decoded.height !== metadata.data.height ||
      decoded.width !== entry.frameColumns * entry.frameWidth || decoded.height !== entry.frameRows * entry.frameHeight ||
      decoded.width > 2_048 || decoded.height > 2_048 || (decoded.pages ?? 1) !== 1) {
    throw new TilesetToolError("tileset_source_image_metadata_mismatch");
  }
  return {
    assetId,
    sha256: stored.asset.sha256,
    body: Buffer.from(stored.body),
    columns: entry.frameColumns,
    rows: entry.frameRows,
    frameWidth: entry.frameWidth,
    frameHeight: entry.frameHeight,
  };
}

async function encodeAtlas(raw: Buffer, width: number, height: number): Promise<Buffer> {
  if (width < 1 || height < 1 || width > 2_048 || height > 2_048 || width * height > GENERATED_ASSET_MAX_PIXELS || raw.byteLength !== width * height * 4) {
    throw new TilesetToolError("tileset_dimensions_invalid");
  }
  try {
    return await sharp(raw, { raw: { width, height, channels: 4 }, limitInputPixels: GENERATED_ASSET_MAX_PIXELS })
      .png({ compressionLevel: 9, adaptiveFiltering: false, force: true })
      .toBuffer();
  } catch {
    throw new TilesetToolError("tileset_png_encode_failed");
  }
}

async function assertWorkspaceOutput(
  sandbox: TilesetSandbox,
  projectId: string,
  path: string,
  expected: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  const existing = await readOptionalBinary(sandbox, projectId, path, signal);
  if (existing && !Buffer.from(existing).equals(Buffer.from(expected))) throw new TilesetToolError("tileset_workspace_path_conflict");
}

async function assertWorkspaceTextOutput(
  sandbox: TilesetSandbox,
  projectId: string,
  path: string,
  expected: string,
  signal: AbortSignal,
): Promise<void> {
  const existing = await readOptionalText(sandbox, projectId, path, signal);
  if (existing !== undefined && existing !== expected) throw new TilesetToolError("tileset_workspace_path_conflict");
}

async function readOptionalBinary(sandbox: TilesetSandbox, projectId: string, path: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
  try {
    return await sandbox.readBinaryFile(projectId, path, signal);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw new TilesetToolError("tileset_workspace_read_failed");
  }
}

async function readOptionalText(sandbox: TilesetSandbox, projectId: string, path: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    return (await sandbox.readFile(projectId, path, signal)).content;
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw new TilesetToolError("tileset_workspace_read_failed");
  }
}

async function restoreWorkspaceFile(sandbox: TilesetSandbox, projectId: string, path: string, previous: string | undefined, signal: AbortSignal): Promise<void> {
  if (previous === undefined) {
    await removeWorkspaceFile(sandbox, projectId, path, signal);
    return;
  }
  await sandbox.writeFile(projectId, path, previous, signal).catch(() => undefined);
}

async function removeWorkspaceFile(sandbox: TilesetSandbox, projectId: string, path: string, signal: AbortSignal): Promise<void> {
  await sandbox.deleteFile(projectId, path, signal).catch(() => undefined);
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
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
