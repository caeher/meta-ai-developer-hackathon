import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import {
  ASSET_INSPECTION_MAX_ENTRIES,
  ASSET_INSPECTION_MAX_FINDINGS,
  ASSET_INSPECTION_MAX_JSON_BYTES,
  ASSET_INSPECTION_MAX_REPORT_BYTES,
  AssetInspectionFindingSchema,
  GeneratedAssetMetadataSchema,
  InspectAssetInputSchema,
  InspectAssetResultSchema,
  type AssetInspectionFinding,
  type AssetInspectionKind,
  type InspectAssetInput,
  type InspectAssetResult,
} from "@meta-game/contracts";
import { OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import type { StorageAsset } from "@meta-game/storage";
import type { SandboxControllerClient } from "@meta-game/sandbox";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2_048;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_DESCRIPTOR_ENTRIES = ASSET_INSPECTION_MAX_ENTRIES;
const MAX_LAYERS = 16;
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const imageExtension = /\.(?:png|jpe?g|webp|gif)$/i;
const assetRoot = "public/assets/";
const allowedAssetGroups = new Set(["generated", "atlases", "tilesets", "tilemaps", "animations"]);

type StoredAsset = Pick<StorageAsset, "id" | "projectId" | "contentType" | "sizeBytes" | "sha256" | "metadata">;
export interface AssetInspectionSource {
  readWorkspaceText(path: string, signal?: AbortSignal): Promise<string>;
  readWorkspaceBinary(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  readStoredAsset(assetId: string): Promise<{ asset: StoredAsset; body: Uint8Array }>;
}

type AssetReader = Pick<SandboxControllerClient, "readFile" | "readBinaryFile">;
type AssetStorageReader = Readonly<{
  read(identity: VerifiedIdentityContext, assetId: string): Promise<{ asset: StoredAsset; body: Uint8Array }>;
}>;
export type InspectAssetToolContext = Readonly<{
  claim: RunWorkerClaim;
  projectId: string;
  signal: AbortSignal;
}>;

export function createInspectAssetTool(input: {
  sandbox: AssetReader;
  storage: AssetStorageReader;
  identity(claim: RunWorkerClaim): Promise<VerifiedIdentityContext>;
}) {
  return async function inspectAssetTool(raw: Record<string, unknown>, context: InspectAssetToolContext): Promise<InspectAssetResult> {
    const parsed = InspectAssetInputSchema.safeParse(raw);
    if (!parsed.success) throw new Error("agent_invalid_tool_arguments");
    if (context.projectId !== context.claim.projectId) throw new OwnedResourceNotFoundError();
    const source: AssetInspectionSource = {
      readWorkspaceText: async (filePath, signal) => (await input.sandbox.readFile(context.projectId, filePath, signal)).content,
      readWorkspaceBinary: (filePath, signal) => input.sandbox.readBinaryFile(context.projectId, filePath, signal),
      readStoredAsset: async (assetId) => {
        const identity = await input.identity(context.claim);
        const stored = await input.storage.read(identity, assetId);
        if (stored.asset.projectId !== context.projectId) throw new OwnedResourceNotFoundError();
        return stored;
      },
    };
    return inspectAsset(parsed.data, source, context.signal);
  };
}

export async function inspectAsset(
  input: InspectAssetInput,
  source: AssetInspectionSource,
  signal?: AbortSignal,
): Promise<InspectAssetResult> {
  const parsed = InspectAssetInputSchema.parse(input);
  const findings: AssetInspectionFinding[] = [];
  const addFinding = (finding: AssetInspectionFinding) => {
    if (findings.length < ASSET_INSPECTION_MAX_FINDINGS - 1) findings.push(AssetInspectionFindingSchema.parse(finding));
    else if (findings.at(-1)?.code !== "findings_truncated") {
      findings.push({ severity: "warning", code: "findings_truncated", message: "Se alcanzó el límite de hallazgos del reporte." });
    }
  };
  let pathLabel = parsed.workspacePath ?? "private asset";
  let assetId: string | undefined;
  let body: Uint8Array;
  let json: unknown;
  let expectedStored: StoredAsset | undefined;
  let kind = parsed.kind === "auto" ? undefined : parsed.kind;

  if (parsed.assetId) {
    assetId = parsed.assetId;
    pathLabel = "private asset";
    const stored = await source.readStoredAsset(parsed.assetId);
    expectedStored = stored.asset;
    body = stored.body;
    kind = "image";
    if (parsed.kind !== "auto" && parsed.kind !== "image") {
      addFinding({ severity: "error", code: "asset_kind_mismatch", message: "Los assets privados de almacenamiento se inspeccionan como imágenes; los descriptores se leen desde el workspace.", path: pathLabel });
    }
    if (body.byteLength !== stored.asset.sizeBytes || sha256(body) !== stored.asset.sha256) {
      addFinding({ severity: "error", code: "storage_checksum_mismatch", message: "Los bytes no coinciden con el checksum registrado." });
    }
  } else if (imageExtension.test(parsed.workspacePath ?? "") || kind === "image") {
    body = await source.readWorkspaceBinary(parsed.workspacePath!, signal);
    kind ??= "image";
  } else {
    const content = await source.readWorkspaceText(parsed.workspacePath!, signal);
    body = Buffer.from(content, "utf8");
    if (body.byteLength > ASSET_INSPECTION_MAX_JSON_BYTES) {
      addFinding({ severity: "error", code: "descriptor_too_large", message: "El descriptor supera el límite de 1 MiB.", path: parsed.workspacePath });
      return finish("manifest", parsed.workspacePath!, body, undefined, findings, assetId);
    }
    try {
      json = JSON.parse(content) as unknown;
    } catch {
      addFinding({ severity: "error", code: "json_malformed", message: "El descriptor no contiene JSON válido.", path: parsed.workspacePath });
      return finish(kind ?? inferKindFromPath(parsed.workspacePath!), parsed.workspacePath!, body, undefined, findings, assetId);
    }
    kind ??= inferKind(json);
  }

  if (!kind) {
    addFinding({ severity: "error", code: "asset_kind_unknown", message: "No se pudo identificar un formato compatible con Phaser 3.90.", path: pathLabel });
    return finish("manifest", pathLabel, body, undefined, findings, assetId);
  }

  let dimensions: InspectAssetResult["dimensions"];
  let frameCount: number | undefined;
  let mainImage: DecodedImage | undefined;
  if (kind === "image") {
    mainImage = await decodeImage(body, pathLabel, addFinding, expectedStored?.contentType);
    dimensions = mainImage ? { width: mainImage.width, height: mainImage.height } : undefined;
    frameCount = 1;
    if (expectedStored) compareStoredImageMetadata(expectedStored, mainImage, body, addFinding);
    if (parsed.checks.includes("alpha") && mainImage) {
      const alpha = await inspectAlpha(body);
      if (alpha.error) addFinding({ severity: "error", code: "image_alpha_decode_failed", message: "No se pudo inspeccionar el canal alpha.", path: pathLabel });
      else if (expectedStored?.metadata?.requestedTransparency === true && !alpha.transparentPixels) {
        addFinding({ severity: "error", code: "image_alpha_missing", message: "El asset declara transparencia solicitada, pero no contiene píxeles transparentes.", path: pathLabel });
      }
    }
    const metadata = expectedStored?.metadata;
    if (parsed.checks.includes("frame-grid") && metadata) {
      const generated = GeneratedAssetMetadataSchema.safeParse(metadata);
      if (generated.success && mainImage && (mainImage.width !== generated.data.frames.columns * generated.data.frames.frameWidth ||
          mainImage.height !== generated.data.frames.rows * generated.data.frames.frameHeight)) {
        addFinding({ severity: "error", code: "image_frame_grid_invalid", message: "Las dimensiones no coinciden con la cuadrícula y el tamaño de frame declarados.", path: pathLabel });
      }
    }
  } else if (kind === "atlas") {
    const atlas = parseAtlas(json, pathLabel, addFinding);
    frameCount = atlas.frames.length;
    dimensions = atlas.size;
    const texturePath = resolveAssetReference(pathLabel, atlas.image);
    if (!texturePath) addFinding({ severity: "error", code: "atlas_reference_invalid", message: "La textura del atlas debe ser una ruta relativa dentro de public/assets.", path: pathLabel });
    else {
      const texture = await readReferencedImage(texturePath, source, signal, addFinding, parsed.checks.includes("atlas-references"));
      if (texture) {
        if (atlas.size && (atlas.size.width !== texture.width || atlas.size.height !== texture.height)) {
          addFinding({ severity: "error", code: "atlas_dimensions_mismatch", message: "El tamaño declarado del atlas no coincide con su textura.", path: texturePath });
        }
        dimensions = { width: texture.width, height: texture.height };
      }
    }
    if (parsed.checks.includes("phaser-runtime")) addFinding({ severity: "info", code: "runtime_preview_required", message: "La carga y animación real deben confirmarse en la preview Phaser.", path: pathLabel });
  } else if (kind === "tileset") {
    const tileset = parseTileset(json, pathLabel, addFinding);
    frameCount = tileset.tileCount;
    const imagePath = resolveAssetReference(pathLabel, tileset.image);
    if (!imagePath) addFinding({ severity: "error", code: "tileset_image_reference_invalid", message: "La imagen del tileset debe ser una ruta relativa dentro de public/assets.", path: pathLabel });
    else {
      const image = await readReferencedImage(imagePath, source, signal, addFinding, parsed.checks.includes("tileset-grid"));
      if (image) {
        dimensions = { width: image.width, height: image.height };
        validateTilesetGrid(tileset, image.width, image.height, imagePath, addFinding);
      }
    }
  } else if (kind === "tilemap") {
    const map = parseTilemap(json, pathLabel, addFinding);
    frameCount = map.tileCount;
    dimensions = map.tileWidth && map.tileHeight && map.width && map.height
      ? { width: Math.min(4_096, map.width * map.tileWidth), height: Math.min(4_096, map.height * map.tileHeight) }
      : undefined;
    if (map.width * map.height > MAX_DESCRIPTOR_ENTRIES) addFinding({ severity: "error", code: "tilemap_too_large", message: "El mapa supera 4.096 celdas.", path: pathLabel });
    if (map.width * map.tileWidth > 4_096 || map.height * map.tileHeight > 4_096) {
      addFinding({ severity: "error", code: "tilemap_dimensions_exceeded", message: "La superficie en píxeles del mapa supera 4.096 por lado.", path: pathLabel });
    }
    const tilesets = await resolveMapTilesets(map, pathLabel, source, signal, addFinding);
    validateTilemap(map, tilesets, pathLabel, addFinding);
    if (parsed.checks.includes("phaser-runtime")) addFinding({ severity: "info", code: "runtime_preview_required", message: "El render y las colisiones deben confirmarse en la preview Phaser.", path: pathLabel });
  } else if (kind === "animation") {
    const animation = parseAnimation(json, pathLabel, addFinding);
    frameCount = animation.frames.length;
    if (animation.atlasPath) {
      const atlasPath = resolveAssetReference(pathLabel, animation.atlasPath);
      if (!atlasPath) addFinding({ severity: "error", code: "animation_atlas_reference_invalid", message: "La referencia del atlas debe permanecer dentro de public/assets.", path: pathLabel });
      else {
        const atlasText = await readJsonFile(atlasPath, source, signal, addFinding);
        const atlasFrames = atlasText ? parseAtlas(atlasText, atlasPath, addFinding).frames.map((frame) => frame.name) : [];
        const available = new Set(atlasFrames);
        for (const frameName of animation.frames) {
          if (!available.has(frameName)) addFinding({ severity: "error", code: "animation_frame_missing", message: "La animación referencia un frame que no existe en el atlas.", path: atlasPath });
        }
      }
    } else {
      addFinding({ severity: "warning", code: "animation_atlas_unspecified", message: "No se indicó el atlas que resuelve los nombres de frame.", path: pathLabel });
    }
    if (!Number.isFinite(animation.fps) || animation.fps < 1 || animation.fps > 60) {
      addFinding({ severity: "error", code: "animation_fps_invalid", message: "La frecuencia debe estar entre 1 y 60 fps.", path: pathLabel });
    }
    if (parsed.checks.includes("phaser-runtime")) addFinding({ severity: "info", code: "runtime_preview_required", message: "El orden y la frecuencia reales deben confirmarse en la preview Phaser.", path: pathLabel });
  } else {
    const manifest = await validateManifest(json, pathLabel, source, signal, addFinding);
    frameCount = manifest.assetCount;
    dimensions = manifest.dimensions;
    if (parsed.checks.includes("phaser-runtime")) addFinding({ severity: "info", code: "runtime_preview_required", message: "La carga completa del manifest debe confirmarse en la preview Phaser.", path: pathLabel });
  }

  return finish(kind, pathLabel, body, { dimensions, frameCount }, findings, assetId);
}

type DecodedImage = Readonly<{ width: number; height: number; format: string; hasAlpha: boolean }>;
async function decodeImage(bytes: Uint8Array, pathLabel: string, add: (finding: AssetInspectionFinding) => void, expectedMime?: string): Promise<DecodedImage | undefined> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) {
    add({ severity: "error", code: "image_size_invalid", message: "La imagen debe medir entre 1 byte y 8 MiB.", path: pathLabel });
    return undefined;
  }
  try {
    const metadata = await sharp(Buffer.from(bytes), { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true }).metadata();
    if (!metadata.width || !metadata.height || !metadata.format || !IMAGE_MIME_TYPES[metadata.format]) {
      add({ severity: "error", code: "image_format_unsupported", message: "Formato de imagen no compatible con Phaser 3.90.", path: pathLabel });
      return undefined;
    }
    if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
      add({ severity: "error", code: "image_dimensions_exceeded", message: "La imagen supera los límites de dimensiones o píxeles.", path: pathLabel });
    }
    if (expectedMime && expectedMime !== IMAGE_MIME_TYPES[metadata.format]) {
      add({ severity: "error", code: "image_mime_mismatch", message: "El MIME registrado no coincide con el formato decodificado.", path: pathLabel });
    }
    return { width: metadata.width, height: metadata.height, format: metadata.format, hasAlpha: metadata.hasAlpha === true };
  } catch {
    add({ severity: "error", code: "image_decode_failed", message: "Los bytes no se pueden decodificar como una imagen completa.", path: pathLabel });
    return undefined;
  }
}

async function inspectAlpha(bytes: Uint8Array): Promise<{ transparentPixels: boolean; error?: true }> {
  try {
    const alpha = await sharp(Buffer.from(bytes), { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS }).ensureAlpha().extractChannel(3).raw().toBuffer();
    return { transparentPixels: alpha.some((value) => value < 255) };
  } catch { return { transparentPixels: false, error: true }; }
}

function compareStoredImageMetadata(asset: StoredAsset, image: DecodedImage | undefined, body: Uint8Array, add: (finding: AssetInspectionFinding) => void): void {
  const metadata = asset.metadata ?? {};
  const digest = sha256(body);
  if (digest !== asset.sha256 || (typeof metadata.sha256 === "string" && metadata.sha256 !== digest)) {
    add({ severity: "error", code: "storage_metadata_checksum_mismatch", message: "El checksum del contenido no coincide con el registro privado.", path: "private asset" });
  }
  if (typeof metadata.width === "number" && image && metadata.width !== image.width ||
      typeof metadata.height === "number" && image && metadata.height !== image.height) {
    add({ severity: "error", code: "storage_metadata_dimensions_mismatch", message: "Las dimensiones no coinciden con los metadatos privados.", path: "private asset" });
  }
  if (metadata.source === "meta-model-api" && !GeneratedAssetMetadataSchema.safeParse(metadata).success) {
    add({ severity: "error", code: "storage_metadata_invalid", message: "Los metadatos de generación no cumplen el contrato guardado.", path: "private asset" });
  }
}

type AtlasFrame = Readonly<{ name: string; x: number; y: number; width: number; height: number; pivot?: { x: number; y: number } }>;
type AtlasData = Readonly<{ image: string; size?: { width: number; height: number }; frames: AtlasFrame[] }>;
function parseAtlas(value: unknown, sourcePath: string, add: (finding: AssetInspectionFinding) => void): AtlasData {
  if (!isRecord(value)) {
    add({ severity: "error", code: "atlas_invalid", message: "El atlas debe ser un objeto Phaser JSON Hash.", path: sourcePath });
    return { image: "", frames: [] };
  }
  const meta = isRecord(value.meta) ? value.meta : undefined;
  const rawSize = meta && isRecord(meta.size) ? meta.size : undefined;
  const size = rawSize && positiveInt(rawSize.w) && positiveInt(rawSize.h) && rawSize.w <= 4_096 && rawSize.h <= 4_096
    ? { width: rawSize.w, height: rawSize.h } : undefined;
  const image = meta && typeof meta.image === "string" ? meta.image : "";
  if (!size) add({ severity: "error", code: "atlas_size_invalid", message: "El atlas requiere meta.size.w y meta.size.h entre 1 y 4.096.", path: sourcePath });
  const entries: Array<[string, unknown]> = [];
  if (isRecord(value.frames)) entries.push(...Object.entries(value.frames));
  else if (Array.isArray(value.frames)) {
    if (value.frames.length > MAX_DESCRIPTOR_ENTRIES) add({ severity: "error", code: "atlas_frame_limit", message: "El atlas supera 4.096 frames.", path: sourcePath });
    for (const frame of value.frames.slice(0, MAX_DESCRIPTOR_ENTRIES)) {
      const frameName = isRecord(frame) && typeof frame.filename === "string" ? frame.filename
        : isRecord(frame) && typeof frame.name === "string" ? frame.name : "";
      entries.push([frameName, frame]);
    }
  } else add({ severity: "error", code: "atlas_frames_invalid", message: "El atlas requiere un objeto o arreglo de frames.", path: sourcePath });
  if (entries.length > MAX_DESCRIPTOR_ENTRIES) add({ severity: "error", code: "atlas_frame_limit", message: "El atlas supera 4.096 frames.", path: sourcePath });
  const names = new Set<string>();
  const frames: AtlasFrame[] = [];
  for (const [name, rawFrame] of entries.slice(0, MAX_DESCRIPTOR_ENTRIES)) {
    if (!name || name.length > 160 || names.has(name)) {
      add({ severity: "error", code: "atlas_frame_name_invalid", message: "El atlas contiene un nombre de frame vacío, repetido o demasiado largo.", path: sourcePath });
      continue;
    }
    names.add(name);
    if (!isRecord(rawFrame) || !isRecord(rawFrame.frame)) {
      add({ severity: "error", code: "atlas_frame_invalid", message: "Cada frame requiere un rectángulo x, y, w, h.", path: sourcePath });
      continue;
    }
    const rect = rawFrame.frame;
    if (!nonnegativeInt(rect.x) || !nonnegativeInt(rect.y) || !positiveInt(rect.w) || !positiveInt(rect.h)) {
      add({ severity: "error", code: "atlas_rect_invalid", message: "El rectángulo del frame debe tener origen no negativo y tamaño positivo.", path: sourcePath });
      continue;
    }
    if (size && (rect.x + rect.w > size.width || rect.y + rect.h > size.height)) {
      add({ severity: "error", code: "atlas_rect_out_of_bounds", message: "El rectángulo del frame sale de los límites de la textura.", path: sourcePath });
    }
    const pivotValue = isRecord(rawFrame.pivot) ? rawFrame.pivot : undefined;
    let pivot: { x: number; y: number } | undefined;
    if (pivotValue) {
      if (!unitInterval(pivotValue.x) || !unitInterval(pivotValue.y)) {
        add({ severity: "error", code: "atlas_pivot_out_of_bounds", message: "El pivote del frame debe permanecer entre 0 y 1.", path: sourcePath });
      } else pivot = { x: pivotValue.x, y: pivotValue.y };
    }
    frames.push({ name, x: rect.x, y: rect.y, width: rect.w, height: rect.h, ...(pivot ? { pivot } : {}) });
  }
  for (let i = 0; i < frames.length; i += 1) {
    const left = frames[i]!;
    for (let j = i + 1; j < frames.length; j += 1) {
      const right = frames[j]!;
      if (left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y) {
        add({ severity: "error", code: "atlas_frame_overlap", message: "Dos rectángulos de frame se solapan.", path: sourcePath });
        i = frames.length;
        break;
      }
    }
  }
  return { image, size, frames };
}

type TilesetData = Readonly<{
  image: string;
  firstGid: number;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  tileCount: number;
  margin: number;
  spacing: number;
  collisionTileIds: Set<number>;
}>;
function parseTileset(value: unknown, sourcePath: string, add: (finding: AssetInspectionFinding) => void): TilesetData {
  if (!isRecord(value)) {
    add({ severity: "error", code: "tileset_invalid", message: "El tileset debe ser un objeto JSON de Phaser/Tiled.", path: sourcePath });
    return emptyTileset();
  }
  const tileWidth = firstNumber(value.tilewidth, value.tileWidth);
  const tileHeight = firstNumber(value.tileheight, value.tileHeight);
  const columns = firstNumber(value.columns);
  const tileCount = firstNumber(value.tilecount, value.tileCount);
  const image = typeof value.image === "string" ? value.image : "";
  const firstGid = firstNumber(value.firstgid, value.firstGid) ?? 1;
  const margin = firstNumber(value.margin) ?? 0;
  const spacing = firstNumber(value.spacing) ?? 0;
  if (!image || !positiveInt(tileWidth) || !positiveInt(tileHeight) || tileWidth > 256 || tileHeight > 256 ||
      !positiveInt(columns) || !positiveInt(tileCount) || tileCount > MAX_DESCRIPTOR_ENTRIES ||
      !positiveInt(firstGid) || !nonnegativeInt(margin) || !nonnegativeInt(spacing)) {
    add({ severity: "error", code: "tileset_geometry_invalid", message: "El tileset requiere imagen, tamaño de tile, columnas, conteo, margen y separación válidos.", path: sourcePath });
  }
  const collisionTileIds = new Set<number>();
  const tiles = Array.isArray(value.tiles) ? value.tiles : [];
  if (tiles.length > MAX_DESCRIPTOR_ENTRIES) add({ severity: "error", code: "tileset_tile_limit", message: "El tileset supera 4.096 definiciones de tile.", path: sourcePath });
  for (const tile of tiles.slice(0, MAX_DESCRIPTOR_ENTRIES)) {
    if (!isRecord(tile)) continue;
    const id = firstNumber(tile.id, tile.index);
    if (!nonnegativeInt(id) || (positiveInt(tileCount) && id >= tileCount)) {
      add({ severity: "error", code: "tileset_tile_out_of_range", message: "Un tile declarado sale del rango del tileset.", path: sourcePath });
      continue;
    }
    const collides = tile.collides === true || hasCollisionProperty(tile.properties) || isRecord(tile.objectgroup) && Array.isArray(tile.objectgroup.objects) && tile.objectgroup.objects.length > 0;
    if (collides) collisionTileIds.add(id);
  }
  return {
    image,
    firstGid: positiveInt(firstGid) ? firstGid : 1,
    tileWidth: positiveInt(tileWidth) ? tileWidth : 0,
    tileHeight: positiveInt(tileHeight) ? tileHeight : 0,
    columns: positiveInt(columns) ? columns : 0,
    tileCount: positiveInt(tileCount) ? tileCount : 0,
    margin: nonnegativeInt(margin) ? margin : 0,
    spacing: nonnegativeInt(spacing) ? spacing : 0,
    collisionTileIds,
  };
}

function validateTilesetGrid(tileset: TilesetData, width: number, height: number, pathLabel: string, add: (finding: AssetInspectionFinding) => void): void {
  if (!tileset.tileWidth || !tileset.tileHeight || !tileset.columns || !tileset.tileCount) return;
  const cellWidth = tileset.tileWidth + tileset.spacing;
  const cellHeight = tileset.tileHeight + tileset.spacing;
  const usableWidth = width - tileset.margin * 2 + tileset.spacing;
  const usableHeight = height - tileset.margin * 2 + tileset.spacing;
  if (usableWidth < 0 || usableHeight < 0 || usableWidth % cellWidth !== 0 || usableHeight % cellHeight !== 0) {
    add({ severity: "error", code: "tileset_grid_mismatch", message: "Las dimensiones de la imagen no forman una cuadrícula completa con ese margen y separación.", path: pathLabel });
    return;
  }
  const columns = usableWidth / cellWidth;
  const rows = usableHeight / cellHeight;
  if (columns !== tileset.columns || tileset.tileCount > columns * rows) {
    add({ severity: "error", code: "tileset_count_mismatch", message: "Columnas o cantidad de tiles no caben en la imagen.", path: pathLabel });
  }
}

type TilemapLayer = Readonly<{ name: string; width: number; height: number; data?: number[]; tiles?: Array<{ x: number; y: number; index: number }>; collision: boolean }>;
type TilemapData = Readonly<{ width: number; height: number; tileWidth: number; tileHeight: number; tileCount: number; layers: TilemapLayer[]; tilesetPaths: string[]; embeddedTilesets: TilesetData[] }>;
function parseTilemap(value: unknown, sourcePath: string, add: (finding: AssetInspectionFinding) => void): TilemapData {
  if (!isRecord(value)) {
    add({ severity: "error", code: "tilemap_invalid", message: "El mapa debe ser un objeto JSON de Phaser/Tiled.", path: sourcePath });
    return emptyTilemap();
  }
  const width = firstNumber(value.width, value.columns) ?? 0;
  const height = firstNumber(value.height, value.rows) ?? 0;
  const tileWidth = firstNumber(value.tilewidth, value.tileWidth) ?? 0;
  const tileHeight = firstNumber(value.tileheight, value.tileHeight) ?? 0;
  const rawLayers = Array.isArray(value.layers) ? value.layers : [];
  if (!positiveInt(width) || !positiveInt(height) || !positiveInt(tileWidth) || !positiveInt(tileHeight) || rawLayers.length < 1 || rawLayers.length > MAX_LAYERS) {
    add({ severity: "error", code: "tilemap_geometry_invalid", message: "El mapa requiere dimensiones positivas y entre 1 y 16 capas.", path: sourcePath });
  }
  if (value.infinite === true) add({ severity: "error", code: "tilemap_infinite_unsupported", message: "Los mapas infinitos no se cargan con este contrato de Phaser.", path: sourcePath });
  const layers: TilemapLayer[] = [];
  let tileCount = 0;
  for (const rawLayer of rawLayers.slice(0, MAX_LAYERS)) {
    if (!isRecord(rawLayer)) continue;
    const layerWidth = firstNumber(rawLayer.width) ?? width;
    const layerHeight = firstNumber(rawLayer.height) ?? height;
    if (rawLayer.type === "tilelayer" && Array.isArray(rawLayer.data)) {
      const data = rawLayer.data.filter((item): item is number => Number.isSafeInteger(item));
      if (rawLayer.data.length !== layerWidth * layerHeight || rawLayer.data.length > MAX_DESCRIPTOR_ENTRIES || data.length !== rawLayer.data.length) {
        add({ severity: "error", code: "tilemap_layer_data_invalid", message: "La capa tilelayer no coincide con su ancho, alto o límite de datos.", path: sourcePath });
      }
      tileCount += data.filter((item) => item !== 0).length;
      layers.push({ name: typeof rawLayer.name === "string" ? rawLayer.name.slice(0, 80) : "layer", width: layerWidth, height: layerHeight, data, collision: rawLayer.collides === true || hasCollisionProperty(rawLayer.properties) });
    } else if (Array.isArray(rawLayer.tiles)) {
      if (rawLayer.tiles.length > MAX_DESCRIPTOR_ENTRIES) add({ severity: "error", code: "tilemap_layer_too_large", message: "La capa supera 4.096 tiles.", path: sourcePath });
      const seen = new Set<string>();
      const tiles: Array<{ x: number; y: number; index: number }> = [];
      for (const tile of rawLayer.tiles.slice(0, MAX_DESCRIPTOR_ENTRIES)) {
        if (!isRecord(tile) || !nonnegativeInt(tile.x) || !nonnegativeInt(tile.y) || !nonnegativeInt(tile.index)) {
          add({ severity: "error", code: "tilemap_coordinate_invalid", message: "Cada tile requiere coordenadas e índice no negativos.", path: sourcePath });
          continue;
        }
        const coordinate = `${tile.x},${tile.y}`;
        if (seen.has(coordinate)) add({ severity: "error", code: "tilemap_duplicate_coordinates", message: "La capa repite una coordenada de tile.", path: sourcePath });
        seen.add(coordinate);
        if (tile.x >= width || tile.y >= height) add({ severity: "error", code: "tilemap_coordinate_out_of_bounds", message: "La coordenada del tile sale de los límites del mapa.", path: sourcePath });
        tiles.push({ x: tile.x, y: tile.y, index: tile.index });
      }
      tileCount += tiles.length;
      layers.push({ name: typeof rawLayer.name === "string" ? rawLayer.name.slice(0, 80) : "layer", width, height, tiles, collision: rawLayer.collides === true });
    } else if (rawLayer.type === "objectgroup" || rawLayer.type === "imagelayer" || rawLayer.type === "group") {
      continue;
    } else add({ severity: "error", code: "tilemap_layer_invalid", message: "La capa no tiene un tipo de Phaser/Tiled reconocido.", path: sourcePath });
  }
  if (tileCount > MAX_DESCRIPTOR_ENTRIES) add({ severity: "error", code: "tilemap_too_many_tiles", message: "El mapa supera 4.096 celdas pobladas.", path: sourcePath });
  const embeddedTilesets = (Array.isArray(value.tilesets) ? value.tilesets : []).filter(isRecord).map((entry) => parseTileset(entry, sourcePath, add));
  const tilesetPaths = typeof value.tilesetPath === "string" ? [value.tilesetPath]
    : Array.isArray(value.tilesetPaths) ? value.tilesetPaths.filter((item): item is string => typeof item === "string").slice(0, 16) : [];
  if (!embeddedTilesets.length && !tilesetPaths.length) add({ severity: "error", code: "tilemap_tileset_missing", message: "El mapa no referencia un tileset embebido o separado.", path: sourcePath });
  return { width, height, tileWidth, tileHeight, tileCount, layers, tilesetPaths, embeddedTilesets };
}

function validateTilemap(map: TilemapData, tilesets: TilesetData[], sourcePath: string, add: (finding: AssetInspectionFinding) => void): void {
  for (const layer of map.layers) {
    let collisionTileMissing = false;
    if (layer.data) {
      for (const gid of layer.data) {
        if (gid < 0) add({ severity: "error", code: "tilemap_gid_invalid", message: "Un índice global de tile es negativo.", path: sourcePath });
        else if (gid > 0) {
          const tileset = tilesets.find((candidate) => gid >= candidate.firstGid && gid < candidate.firstGid + candidate.tileCount);
          if (!tileset) add({ severity: "error", code: "tilemap_tile_out_of_range", message: "La capa referencia un tile que no existe en los tilesets.", path: sourcePath });
          else if (layer.collision && !tileset.collisionTileIds.has(gid - tileset.firstGid)) collisionTileMissing = true;
        }
      }
    }
    for (const tile of layer.tiles ?? []) {
      const tileset = tilesets.find((candidate) => tile.index < candidate.tileCount);
      if (!tileset) {
        add({ severity: "error", code: "tilemap_tile_out_of_range", message: "La capa referencia un tile que no existe en los tilesets.", path: sourcePath });
      }
      else if (layer.collision && !tileset.collisionTileIds.has(tile.index)) collisionTileMissing = true;
    }
    if (layer.collision && collisionTileMissing) {
      add({ severity: "warning", code: "tilemap_collision_metadata_missing", message: "La capa pide colisión, pero algunos tiles no declaran propiedades de colisión.", path: sourcePath });
    }
  }
}

async function resolveMapTilesets(map: TilemapData, sourcePath: string, source: AssetInspectionSource, signal: AbortSignal | undefined, add: (finding: AssetInspectionFinding) => void): Promise<TilesetData[]> {
  const tilesets = [...map.embeddedTilesets];
  for (const reference of map.tilesetPaths) {
    const tilesetPath = resolveAssetReference(sourcePath, reference);
    if (!tilesetPath) {
      add({ severity: "error", code: "tilemap_tileset_reference_invalid", message: "La referencia del tileset sale de public/assets.", path: sourcePath });
      continue;
    }
    const json = await readJsonFile(tilesetPath, source, signal, add);
    if (!json) continue;
    const tileset = parseTileset(json, tilesetPath, add);
    const imagePath = resolveAssetReference(tilesetPath, tileset.image);
    if (!imagePath) add({ severity: "error", code: "tileset_image_reference_invalid", message: "La imagen del tileset debe ser una ruta relativa dentro de public/assets.", path: tilesetPath });
    else {
      const image = await readReferencedImage(imagePath, source, signal, add, true);
      if (image) validateTilesetGrid(tileset, image.width, image.height, imagePath, add);
    }
    tilesets.push(tileset);
  }
  for (const tileset of map.embeddedTilesets) {
    const imagePath = resolveAssetReference(sourcePath, tileset.image);
    if (!imagePath) add({ severity: "error", code: "tileset_image_reference_invalid", message: "La imagen del tileset debe ser una ruta relativa dentro de public/assets.", path: sourcePath });
    else {
      const image = await readReferencedImage(imagePath, source, signal, add, true);
      if (image) validateTilesetGrid(tileset, image.width, image.height, imagePath, add);
    }
  }
  return tilesets;
}

type AnimationData = Readonly<{ fps: number; frames: string[]; atlasPath?: string }>;
function parseAnimation(value: unknown, sourcePath: string, add: (finding: AssetInspectionFinding) => void): AnimationData {
  if (!isRecord(value)) {
    add({ severity: "error", code: "animation_invalid", message: "La animación debe ser un objeto con fps y frames.", path: sourcePath });
    return { fps: 0, frames: [] };
  }
  const fps = firstNumber(value.fps, value.frameRate) ?? 0;
  const rawFrames = Array.isArray(value.frames) ? value.frames : [];
  if (rawFrames.length < 1 || rawFrames.length > 256) add({ severity: "error", code: "animation_frames_invalid", message: "La animación requiere de 1 a 256 nombres de frame ordenados.", path: sourcePath });
  const frames = rawFrames.slice(0, 256).map((frame) => typeof frame === "string" ? frame
    : isRecord(frame) && typeof frame.frame === "string" ? frame.frame
      : isRecord(frame) && typeof frame.name === "string" ? frame.name : "");
  if (frames.some((frame) => !frame || frame.length > 160)) add({ severity: "error", code: "animation_frame_name_invalid", message: "La animación contiene un nombre de frame vacío o demasiado largo.", path: sourcePath });
  if (new Set(frames).size !== frames.length) add({ severity: "error", code: "animation_frame_name_duplicate", message: "La animación repite un nombre de frame.", path: sourcePath });
  return { fps, frames, ...(typeof value.atlasPath === "string" ? { atlasPath: value.atlasPath } : {}) };
}

async function validateManifest(value: unknown, sourcePath: string, source: AssetInspectionSource, signal: AbortSignal | undefined, add: (finding: AssetInspectionFinding) => void): Promise<{ assetCount: number; dimensions?: { width: number; height: number } }> {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.assets) || value.assets.length > 128) {
    add({ severity: "error", code: "manifest_invalid", message: "El manifest debe usar schemaVersion 1 y contener hasta 128 assets.", path: sourcePath });
    return { assetCount: 0 };
  }
  const ids = new Set<string>();
  let dimensions: { width: number; height: number } | undefined;
  for (const entry of value.assets.slice(0, 128)) {
    if (!isRecord(entry) || typeof entry.assetId !== "string" || !isUuid(entry.assetId) || entry.key !== `generated-${entry.assetId}` ||
        entry.path !== `assets/generated/${entry.assetId}.png` || !positiveInt(entry.frameColumns) || !positiveInt(entry.frameRows) ||
        !positiveInt(entry.frameWidth) || !positiveInt(entry.frameHeight) || ids.has(entry.assetId)) {
      add({ severity: "error", code: "manifest_entry_invalid", message: "El manifest contiene una referencia o metadato de frame incoherente.", path: sourcePath });
      continue;
    }
    ids.add(entry.assetId);
    const filePath = `public/${entry.path}`;
    const image = await readReferencedImage(filePath, source, signal, add, true);
    if (image) {
      if (image.width !== entry.frameColumns * entry.frameWidth || image.height !== entry.frameRows * entry.frameHeight) {
        add({ severity: "error", code: "manifest_frame_dimensions_mismatch", message: "Las dimensiones del asset no coinciden con el manifest.", path: filePath });
      }
      dimensions = { width: image.width, height: image.height };
    }
  }
  return { assetCount: ids.size, ...(dimensions ? { dimensions } : {}) };
}

async function readReferencedImage(pathLabel: string, source: AssetInspectionSource, signal: AbortSignal | undefined, add: (finding: AssetInspectionFinding) => void, decode: boolean): Promise<DecodedImage | undefined> {
  if (!decode) return undefined;
  try {
    return await decodeImage(await source.readWorkspaceBinary(pathLabel, signal), pathLabel, add);
  } catch {
    add({ severity: "error", code: "asset_reference_missing", message: "No se pudo leer la imagen referenciada desde el workspace actual.", path: pathLabel });
    return undefined;
  }
}

async function readJsonFile(pathLabel: string, source: AssetInspectionSource, signal: AbortSignal | undefined, add: (finding: AssetInspectionFinding) => void): Promise<unknown | undefined> {
  try {
    const text = await source.readWorkspaceText(pathLabel, signal);
    if (Buffer.byteLength(text, "utf8") > ASSET_INSPECTION_MAX_JSON_BYTES) {
      add({ severity: "error", code: "descriptor_too_large", message: "El descriptor referenciado supera el límite de 1 MiB.", path: pathLabel });
      return undefined;
    }
    return JSON.parse(text) as unknown;
  } catch {
    add({ severity: "error", code: "json_malformed", message: "No se pudo leer o analizar el descriptor JSON referenciado.", path: pathLabel });
    return undefined;
  }
}

function resolveAssetReference(sourcePath: string, reference: string): string | undefined {
  if (!reference || reference.length > 240 || reference.includes("\\") || reference.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("/")) return undefined;
  const base = path.posix.dirname(sourcePath);
  const resolved = path.posix.normalize(path.posix.join(base, reference));
  if (!resolved.startsWith(assetRoot)) return undefined;
  const group = resolved.slice(assetRoot.length).split("/")[0];
  if (!group || !allowedAssetGroups.has(group) || resolved.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return undefined;
  return resolved;
}

function inferKind(value: unknown): AssetInspectionKind {
  if (!isRecord(value)) return "manifest";
  if (value.schemaVersion === 1 && Array.isArray(value.assets)) return "manifest";
  if (isRecord(value.meta) && (isRecord(value.frames) || Array.isArray(value.frames))) return "atlas";
  if (value.type === "map" || Array.isArray(value.layers) && (isNumber(value.tileWidth) || isNumber(value.tilewidth))) return "tilemap";
  if ((isNumber(value.tileWidth) || isNumber(value.tilewidth)) && isNumber(value.tileCount ?? value.tilecount)) return "tileset";
  if (Array.isArray(value.frames) && (isNumber(value.fps) || isNumber(value.frameRate))) return "animation";
  return "manifest";
}

function inferKindFromPath(pathLabel: string): AssetInspectionKind {
  const group = pathLabel.slice(assetRoot.length).split("/")[0];
  if (group === "atlases") return "atlas";
  if (group === "tilesets") return "tileset";
  if (group === "tilemaps") return "tilemap";
  if (group === "animations") return "animation";
  return "manifest";
}

function finish(kind: AssetInspectionKind, pathLabel: string, bytes: Uint8Array, fields: { dimensions?: InspectAssetResult["dimensions"]; frameCount?: number } | undefined, findings: AssetInspectionFinding[], assetId?: string): InspectAssetResult {
  const errors = findings.some((finding) => finding.severity === "error");
  const review = findings.some((finding) => finding.severity === "warning" || finding.code === "runtime_preview_required");
  const boundedFindings = findings.slice(0, 16);
  if (findings.length > boundedFindings.length) {
    boundedFindings.push({
      severity: errors ? "error" : "warning",
      code: "additional_findings_truncated",
      message: `${findings.length - 16} hallazgos adicionales se omitieron para limitar el reporte.`,
    });
  }
  let result = InspectAssetResultSchema.parse({
    status: errors ? "invalid" : review ? "needs_review" : "valid",
    kind,
    ...(assetId ? { assetId } : {}),
    path: pathLabel,
    sha256: sha256(bytes),
    ...(fields?.dimensions ? { dimensions: fields.dimensions } : {}),
    ...(fields?.frameCount === undefined ? {} : { frameCount: Math.min(fields.frameCount, ASSET_INSPECTION_MAX_ENTRIES) }),
    findings: boundedFindings,
  });
  while (Buffer.byteLength(JSON.stringify(result), "utf8") > ASSET_INSPECTION_MAX_REPORT_BYTES && result.findings.length > 1) {
    result = InspectAssetResultSchema.parse({ ...result, findings: result.findings.slice(0, -1) });
  }
  return result;
}

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function positiveInt(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonnegativeInt(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function unitInterval(value: unknown): value is number { return isNumber(value) && value >= 0 && value <= 1; }
function firstNumber(...values: unknown[]): number | undefined { return values.find(isNumber); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function hasCollisionProperty(properties: unknown): boolean {
  if (!Array.isArray(properties)) return false;
  return properties.some((property) => isRecord(property) && property.name === "collides" && property.value === true);
}
function emptyTileset(): TilesetData { return { image: "", firstGid: 1, tileWidth: 0, tileHeight: 0, columns: 0, tileCount: 0, margin: 0, spacing: 0, collisionTileIds: new Set() }; }
function emptyTilemap(): TilemapData { return { width: 0, height: 0, tileWidth: 0, tileHeight: 0, tileCount: 0, layers: [], tilesetPaths: [], embeddedTilesets: [] }; }
