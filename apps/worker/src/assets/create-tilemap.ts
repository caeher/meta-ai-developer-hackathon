import { createHash } from "node:crypto";
import {
  CreateTilemapInputSchema,
  CreateTilemapManifestSchema,
  CreateTilemapResultSchema,
  CreateTilesetManifestSchema,
  CreateTilesetMetadataSchema,
  type CreateTilemapInput,
  type CreateTilemapManifest,
  type CreateTilemapResult,
  GENERATED_ASSET_MAX_BYTES,
} from "@meta-game/contracts";
import { OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import type { SandboxControllerClient } from "@meta-game/sandbox";
import { GENERATED_TILESET_MANIFEST_PATH, type TilesetStorage } from "./create-tileset";

export const GENERATED_TILEMAP_MANIFEST_PATH = "public/assets/generated/tilemaps/manifest.json";
const TILEMAP_ASSET_DIR = "assets/generated/tilemaps";
const MAX_TILEMAP_MANIFEST_BYTES = 256 * 1024;
const MAX_TILEMAP_JSON_BYTES = 1_048_576;
const MAX_TILESET_MANIFEST_BYTES = 256 * 1024;

type TilemapSandbox = Pick<SandboxControllerClient,
  "readFile" | "readBinaryFile" | "writeFile" | "deleteFile">;

export type CreateTilemapToolContext = Readonly<{
  claim: RunWorkerClaim;
  callId: string;
  projectId: string;
  signal: AbortSignal;
}>;

export class TilemapToolError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TilemapToolError";
  }
}

export function createCreateTilemapTool(input: {
  storage: TilesetStorage;
  sandbox: TilemapSandbox;
  identity(claim: RunWorkerClaim): Promise<VerifiedIdentityContext>;
}) {
  return async function createTilemapTool(rawInput: Record<string, unknown>, context: CreateTilemapToolContext): Promise<CreateTilemapResult> {
    const parsed = CreateTilemapInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new Error("agent_invalid_tool_arguments");
    if (context.projectId !== context.claim.projectId || !context.callId || context.callId.length > 200) {
      throw new OwnedResourceNotFoundError();
    }
    context.signal.throwIfAborted();

    const request = parsed.data;
    const identity = await input.identity(context.claim);
    if (identity.userId !== context.claim.ownerUserId) throw new OwnedResourceNotFoundError();
    const tileset = await loadTileset(input.storage, input.sandbox, identity, context.projectId, request.tilesetAssetId, context.signal);
    const collisionLayerNames = resolveCollisionLayerNames(request);
    const tilemapAssetId = deterministicUuid(`${context.claim.runId}\0${context.callId}\0tilemap-json`);
    const path = `${TILEMAP_ASSET_DIR}/${tilemapAssetId}.json`;
    const workspacePath = `public/${path}`;
    const json = createPhaserTilemap(request, tileset, tilemapAssetId, collisionLayerNames);
    const body = Buffer.from(`${JSON.stringify(json, null, 2)}\n`, "utf8");
    if (body.byteLength < 1 || body.byteLength > MAX_TILEMAP_JSON_BYTES || body.byteLength > GENERATED_ASSET_MAX_BYTES) {
      throw new TilemapToolError("tilemap_json_size_invalid");
    }
    const sha256 = hash(body);
    const collisionTileNames = tileset.metadata.tiles
      .filter((tile) => tile.collides && request.layers.some((layer) => collisionLayerNames.includes(layer.name) && layer.cells.some((cell) => cell.tileName === tile.tileName)))
      .map((tile) => tile.tileName);
    const result = CreateTilemapResultSchema.parse({
      tilemapAssetId,
      tilesetAssetId: tileset.metadata.tilesetAssetId,
      path,
      sha256,
      width: request.width,
      height: request.height,
      tileSize: tileset.metadata.tileSize,
      layerNames: request.layers.map(({ name }) => name),
      cellCount: request.layers.reduce((count, layer) => count + layer.cells.length, 0),
      collisionTileNames,
      phaserFormat: "phaser-3-tilemap-json",
    });

    const manifestText = await readOptionalText(input.sandbox, context.projectId, GENERATED_TILEMAP_MANIFEST_PATH, context.signal);
    const manifest = parseManifest(manifestText);
    const existingById = manifest.tilemaps.find((entry) => entry.tilemapAssetId === tilemapAssetId);
    const existingByName = manifest.tilemaps.find((entry) => entry.name === request.name);
    if (existingByName && existingByName.tilemapAssetId !== tilemapAssetId) throw new TilemapToolError("tilemap_name_conflict");
    const manifestEntry = {
      tilemapAssetId,
      name: request.name,
      tilesetAssetId: result.tilesetAssetId,
      path,
      sha256,
      width: result.width,
      height: result.height,
      tileSize: result.tileSize,
      layerNames: result.layerNames,
      cellCount: result.cellCount,
      collisionTileNames: result.collisionTileNames,
    };
    if (existingById && JSON.stringify(existingById) !== JSON.stringify(manifestEntry)) {
      throw new TilemapToolError("tilemap_idempotency_conflict");
    }
    const updatedManifest = CreateTilemapManifestSchema.parse({
      schemaVersion: 1,
      tilemaps: existingById ? manifest.tilemaps : [...manifest.tilemaps, manifestEntry],
    });
    const updatedManifestText = `${JSON.stringify(updatedManifest, null, 2)}\n`;
    if (Buffer.byteLength(updatedManifestText, "utf8") > MAX_TILEMAP_MANIFEST_BYTES) throw new TilemapToolError("tilemap_manifest_too_large");
    if (!existingById && updatedManifest.tilemaps.length > 128) throw new TilemapToolError("tilemap_manifest_limit");

    const existingText = await readOptionalText(input.sandbox, context.projectId, workspacePath, context.signal);
    if (existingText !== undefined && existingText !== body.toString("utf8")) throw new TilemapToolError("tilemap_workspace_conflict");
    const oldManifestText = manifestText;
    const manifestWorkspacePath = GENERATED_TILEMAP_MANIFEST_PATH;
    const assetMetadata = {
      schemaVersion: 1,
      assetType: "tilemap",
      tilemapAssetId,
      tilesetAssetId: result.tilesetAssetId,
      sha256,
      path,
      runId: context.claim.runId,
      callId: context.callId,
    };

    context.signal.throwIfAborted();
    let uploaded = false;
    let fileWriteAttempted = false;
    let manifestWriteAttempted = false;
    try {
      const stored = await input.storage.upload(identity, {
        assetId: tilemapAssetId,
        projectId: context.projectId,
        contentType: "application/json",
        body,
        metadata: assetMetadata,
      });
      uploaded = stored.id === tilemapAssetId && stored.created !== false;
      if (stored.id !== tilemapAssetId || stored.status !== "ready" || stored.sha256 !== sha256) {
        throw new TilemapToolError("tilemap_storage_failed");
      }

      context.signal.throwIfAborted();
      if (existingText === undefined) {
        fileWriteAttempted = true;
        try {
          const written = await input.sandbox.writeFile(context.projectId, workspacePath, body.toString("utf8"), context.signal);
          if (written.bytesWritten !== body.byteLength) throw new TilemapToolError("tilemap_workspace_write_failed");
        } catch (error) {
          if (context.signal.aborted || error instanceof TilemapToolError) throw error;
          throw new TilemapToolError("tilemap_workspace_write_failed");
        }
      }
      if (!existingById) {
        manifestWriteAttempted = true;
        try {
          const written = await input.sandbox.writeFile(context.projectId, manifestWorkspacePath, updatedManifestText, context.signal);
          if (written.bytesWritten !== Buffer.byteLength(updatedManifestText, "utf8")) throw new TilemapToolError("tilemap_manifest_write_failed");
        } catch (error) {
          if (context.signal.aborted || error instanceof TilemapToolError) throw error;
          throw new TilemapToolError("tilemap_manifest_write_failed");
        }
      }
      return result;
    } catch (error) {
      const cleanupSignal = new AbortController().signal;
      if (manifestWriteAttempted) await restoreWorkspaceFile(input.sandbox, context.projectId, manifestWorkspacePath, oldManifestText, cleanupSignal);
      if (fileWriteAttempted) await removeWorkspaceFile(input.sandbox, context.projectId, workspacePath, cleanupSignal);
      if (uploaded) await input.storage.delete(identity, tilemapAssetId).catch(() => undefined);
      throw error;
    }
  };
}

type ValidatedTileset = Readonly<{
  metadata: ReturnType<typeof CreateTilesetMetadataSchema.parse>;
}>;

async function loadTileset(
  storage: TilesetStorage,
  sandbox: TilemapSandbox,
  identity: VerifiedIdentityContext,
  projectId: string,
  tilesetAssetId: string,
  signal: AbortSignal,
): Promise<ValidatedTileset> {
  const manifestText = await readRequiredText(sandbox, projectId, GENERATED_TILESET_MANIFEST_PATH, signal, "tileset_manifest_missing");
  if (Buffer.byteLength(manifestText, "utf8") > MAX_TILESET_MANIFEST_BYTES) throw new TilemapToolError("tileset_manifest_too_large");
  let manifest: ReturnType<typeof CreateTilesetManifestSchema.parse>;
  try {
    manifest = CreateTilesetManifestSchema.parse(JSON.parse(manifestText) as unknown);
  } catch {
    throw new TilemapToolError("tileset_manifest_invalid");
  }
  const entry = manifest.tilesets.find((candidate) => candidate.tilesetAssetId === tilesetAssetId);
  if (!entry) throw new OwnedResourceNotFoundError();

  let image: Awaited<ReturnType<TilesetStorage["read"]>>;
  try {
    image = await storage.read(identity, tilesetAssetId);
  } catch (error) {
    if (error instanceof OwnedResourceNotFoundError) throw error;
    throw new TilemapToolError("tileset_unavailable");
  }
  if (image.asset.id !== tilesetAssetId || image.asset.projectId !== projectId) throw new OwnedResourceNotFoundError();
  if (image.asset.contentType !== "image/png" || image.asset.sizeBytes < 1 || image.asset.sizeBytes > GENERATED_ASSET_MAX_BYTES ||
      image.body.byteLength !== image.asset.sizeBytes || !isSha256(image.asset.sha256) || hash(image.body) !== image.asset.sha256 ||
      image.asset.sha256 !== entry.sha256) {
    throw new TilemapToolError("tileset_image_integrity_invalid");
  }
  const imageAssetMetadata = image.asset.metadata ?? {};
  const metadataAssetId = imageAssetMetadata.metadataAssetId;
  if (imageAssetMetadata.schemaVersion !== 1 || imageAssetMetadata.assetType !== "tileset-image" || imageAssetMetadata.tilesetAssetId !== tilesetAssetId ||
      typeof metadataAssetId !== "string" || !isUuid(metadataAssetId) || imageAssetMetadata.sha256 !== image.asset.sha256) {
    throw new TilemapToolError("tileset_asset_metadata_invalid");
  }

  let descriptor: Awaited<ReturnType<TilesetStorage["read"]>>;
  try {
    descriptor = await storage.read(identity, metadataAssetId);
  } catch (error) {
    if (error instanceof OwnedResourceNotFoundError) throw new TilemapToolError("tileset_metadata_missing");
    throw new TilemapToolError("tileset_metadata_unavailable");
  }
  if (descriptor.asset.id !== metadataAssetId || descriptor.asset.projectId !== projectId) throw new OwnedResourceNotFoundError();
  if (descriptor.asset.contentType !== "application/json" || descriptor.asset.sizeBytes < 1 || descriptor.asset.sizeBytes > 256 * 1024 ||
      descriptor.body.byteLength !== descriptor.asset.sizeBytes || hash(descriptor.body) !== descriptor.asset.sha256) {
    throw new TilemapToolError("tileset_metadata_integrity_invalid");
  }
  let metadata: ReturnType<typeof CreateTilesetMetadataSchema.parse>;
  try {
    metadata = CreateTilesetMetadataSchema.parse(JSON.parse(Buffer.from(descriptor.body).toString("utf8")) as unknown);
  } catch {
    throw new TilemapToolError("tileset_metadata_invalid");
  }
  const descriptorAssetMetadata = descriptor.asset.metadata ?? {};
  if (descriptorAssetMetadata.schemaVersion !== 1 || descriptorAssetMetadata.assetType !== "tileset-metadata" || descriptorAssetMetadata.tilesetAssetId !== tilesetAssetId ||
      descriptorAssetMetadata.metadataAssetId !== metadataAssetId || descriptorAssetMetadata.sha256 !== descriptor.asset.sha256 ||
      descriptorAssetMetadata.imageSha256 !== image.asset.sha256 || descriptorAssetMetadata.metadataPath !== entry.metadataPath ||
      metadata.tilesetAssetId !== tilesetAssetId || metadata.name !== entry.name || metadata.sha256 !== image.asset.sha256 ||
      metadata.sha256 !== entry.sha256 || metadata.tileSize !== entry.tileSize || metadata.columns !== entry.columns ||
      metadata.rows !== entry.rows || metadata.tilecount !== entry.tileCount || imageAssetMetadata.name !== entry.name ||
      imageAssetMetadata.imagePath !== entry.imagePath || imageAssetMetadata.metadataPath !== entry.metadataPath ||
      imageAssetMetadata.tileCount !== entry.tileCount || metadata.tiles.some((tile, index) => tile.id !== index || tile.tileIndex !== index)) {
    throw new TilemapToolError("tileset_metadata_mismatch");
  }

  const workspaceMetadata = await readRequiredText(sandbox, projectId, `public/${metadata.metadataPath}`, signal, "tileset_workspace_metadata_missing");
  if (workspaceMetadata !== Buffer.from(descriptor.body).toString("utf8")) throw new TilemapToolError("tileset_workspace_metadata_mismatch");
  let workspaceImage: Uint8Array;
  try {
    workspaceImage = await sandbox.readBinaryFile(projectId, `public/${metadata.imagePath}`, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TilemapToolError("tileset_workspace_image_missing");
  }
  if (hash(workspaceImage) !== metadata.sha256) throw new TilemapToolError("tileset_workspace_image_mismatch");
  return { metadata };
}

function resolveCollisionLayerNames(request: CreateTilemapInput): string[] {
  const selected = request.collisionLayerNames ?? request.layers.map(({ name }) => name);
  const layerNames = new Set(request.layers.map(({ name }) => name));
  if (selected.some((name) => !layerNames.has(name))) throw new TilemapToolError("tilemap_collision_layer_unknown");
  return selected;
}

function createPhaserTilemap(
  request: CreateTilemapInput,
  tileset: ValidatedTileset,
  tilemapAssetId: string,
  collisionLayerNames: readonly string[],
) {
  const { metadata } = tileset;
  const layers = request.layers.map((layer, index) => {
    const data = Array.from({ length: request.width * request.height }, () => 0);
    for (const cell of layer.cells) {
      const tile = metadata.tiles.find((candidate) => candidate.tileName === cell.tileName);
      if (!tile) throw new TilemapToolError("tilemap_tile_unknown");
      // Tiled GIDs are one based; local tileset IDs stay zero based.
      data[cell.y * request.width + cell.x] = tile.tileIndex + 1;
    }
    return {
      data,
      height: request.height,
      id: index + 1,
      name: layer.name,
      opacity: 1,
      properties: [{ name: "collides", type: "bool", value: collisionLayerNames.includes(layer.name) }],
      type: "tilelayer",
      visible: layer.visible,
      width: request.width,
      x: 0,
      y: 0,
    };
  });
  return {
    compressionlevel: -1,
    height: request.height,
    infinite: false,
    layers,
    nextlayerid: layers.length + 1,
    nextobjectid: 1,
    orientation: "orthogonal",
    properties: [
      { name: "schemaVersion", type: "int", value: 1 },
      { name: "tilemapAssetId", type: "string", value: tilemapAssetId },
      { name: "tilesetAssetId", type: "string", value: metadata.tilesetAssetId },
    ],
    renderorder: "right-down",
    tiledversion: "1.11.2",
    tileheight: metadata.tileSize,
    tilesets: [{
      columns: metadata.columns,
      firstgid: 1,
      image: `../tilesets/${metadata.tilesetAssetId}.png`,
      imageheight: metadata.height,
      imagewidth: metadata.width,
      margin: 0,
      name: metadata.name,
      properties: [{ name: "tilesetAssetId", type: "string", value: metadata.tilesetAssetId }],
      spacing: 0,
      tilecount: metadata.tilecount,
      tileheight: metadata.tileSize,
      tiles: metadata.tiles.map((tile) => ({
        id: tile.tileIndex,
        properties: [
          { name: "collides", type: "bool", value: tile.collides },
          { name: "terrain", type: "string", value: tile.terrain },
          { name: "tileName", type: "string", value: tile.tileName },
        ],
        type: tile.tileName,
      })),
      tilewidth: metadata.tileSize,
    }],
    tilewidth: metadata.tileSize,
    type: "map",
    version: "1.10",
    width: request.width,
  };
}

function parseManifest(text: string | undefined): CreateTilemapManifest {
  if (text === undefined) return { schemaVersion: 1, tilemaps: [] };
  if (Buffer.byteLength(text, "utf8") > MAX_TILEMAP_MANIFEST_BYTES) throw new TilemapToolError("tilemap_manifest_too_large");
  try {
    return CreateTilemapManifestSchema.parse(JSON.parse(text) as unknown);
  } catch {
    throw new TilemapToolError("tilemap_manifest_invalid");
  }
}

async function readRequiredText(sandbox: TilemapSandbox, projectId: string, path: string, signal: AbortSignal, code: string): Promise<string> {
  try {
    const result = await sandbox.readFile(projectId, path, signal);
    return result.content;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TilemapToolError(code);
  }
}

async function readOptionalText(sandbox: TilemapSandbox, projectId: string, path: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    return (await sandbox.readFile(projectId, path, signal)).content;
  } catch (error) {
    if (signal.aborted) throw error;
    if (hasCode(error, "file_not_found") || hasCode(error, "path_not_found")) return undefined;
    throw error;
  }
}

async function restoreWorkspaceFile(sandbox: TilemapSandbox, projectId: string, path: string, previous: string | undefined, signal: AbortSignal): Promise<void> {
  if (previous === undefined) await removeWorkspaceFile(sandbox, projectId, path, signal);
  else await sandbox.writeFile(projectId, path, previous, signal).catch(() => undefined);
}

async function removeWorkspaceFile(sandbox: TilemapSandbox, projectId: string, path: string, signal: AbortSignal): Promise<void> {
  await sandbox.deleteFile(projectId, path, signal).catch(() => undefined);
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
