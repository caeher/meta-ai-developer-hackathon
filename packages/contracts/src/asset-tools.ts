import { z } from "zod";

const spriteViewSchema = z.enum(["side", "front", "top-down", "isometric", "orthographic"]);
const hexPaletteColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const EditSpriteInputBaseSchema = z.object({
  sourceAssetId: z.string().uuid(),
  sourceFrameIndex: z.number().int().min(0).max(63).optional().default(0),
  requestedChange: z.string().trim().min(8).max(800),
  view: spriteViewSchema.optional(),
  palette: z.array(hexPaletteColorSchema).max(8).optional(),
  preserve: z.object({
    canvas: z.boolean(),
    style: z.boolean(),
    palette: z.boolean(),
    characterIdentity: z.boolean(),
  }).strict(),
}).strict();

export const EditSpriteInputSchema = EditSpriteInputBaseSchema.superRefine((input, context) => {
  if (input.palette && new Set(input.palette).size !== input.palette.length) {
    context.addIssue({ code: "custom", path: ["palette"], message: "Palette colors must be unique." });
  }
});

const editSpriteInputJsonSchema = z.toJSONSchema(EditSpriteInputBaseSchema, { target: "draft-7" });
const editSpriteInputProperties = editSpriteInputJsonSchema.properties as Record<string, Record<string, unknown>>;
export const EditSpriteInputJsonSchema = {
  ...editSpriteInputJsonSchema,
  properties: {
    ...editSpriteInputProperties,
    sourceFrameIndex: { ...editSpriteInputProperties.sourceFrameIndex, default: 0 },
    palette: editSpriteInputProperties.palette
      ? { ...editSpriteInputProperties.palette, uniqueItems: true }
      : undefined,
  },
} as const;

export const EditSpriteResultSchema = z.object({
  assetId: z.string().uuid(),
  sourceAssetId: z.string().uuid(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().regex(/^assets\/generated\/[0-9a-f-]{36}\.png$/),
  width: z.number().int().min(1).max(2_048),
  height: z.number().int().min(1).max(2_048),
  reviewStatus: z.literal("pending-in-live-preview"),
  provenance: z.literal("meta-image-edit"),
}).strict().superRefine((result, context) => {
  if (result.path !== `assets/generated/${result.assetId}.png` || result.assetId === result.sourceAssetId) {
    context.addIssue({ code: "custom", path: ["path"], message: "Edited assets need a new ID-derived path." });
  }
});

export const EditSpriteResultJsonSchema = z.toJSONSchema(EditSpriteResultSchema, { target: "draft-7" });

export type EditSpriteInput = z.infer<typeof EditSpriteInputSchema>;
export type EditSpriteResult = z.infer<typeof EditSpriteResultSchema>;

export const TilesetTerrainSchema = z.enum(["ground", "wall", "water", "hazard", "decoration", "unknown"]);

const CreateTilesetTileInputSchema = z.object({
  sourceAssetId: z.string().uuid(),
  sourceFrameIndex: z.number().int().min(0).max(63).default(0),
  tileName: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  collides: z.boolean().default(false),
  terrain: TilesetTerrainSchema.optional(),
}).strict();

const CreateTilesetInputBaseSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{1,47}$/),
  tileSize: z.number().int().min(8).max(128),
  tiles: z.array(CreateTilesetTileInputSchema).min(1).max(256),
  columns: z.number().int().min(1).max(16).optional(),
  layout: z.literal("input-order-row-major").default("input-order-row-major"),
}).strict();

export const CreateTilesetInputSchema = CreateTilesetInputBaseSchema.superRefine((input, context) => {
  const names = new Set<string>();
  for (const [index, tile] of input.tiles.entries()) {
    if (names.has(tile.tileName)) {
      context.addIssue({ code: "custom", path: ["tiles", index, "tileName"], message: "Tile names must be unique." });
    }
    names.add(tile.tileName);
  }
  if (input.columns && Math.ceil(input.tiles.length / input.columns) > 16) {
    context.addIssue({ code: "custom", path: ["columns"], message: "The tile grid may contain at most 16 rows." });
  }
});

const createTilesetInputJson = z.toJSONSchema(CreateTilesetInputBaseSchema, { target: "draft-7" });
const createTilesetInputProperties = createTilesetInputJson.properties as Record<string, Record<string, unknown>>;
const createTilesetTileInputProperties = createTilesetInputProperties.tiles?.items as Record<string, unknown>;
const createTilesetTileProperties = createTilesetTileInputProperties.properties as Record<string, Record<string, unknown>>;
export const CreateTilesetInputJsonSchema = {
  ...createTilesetInputJson,
  properties: {
    ...createTilesetInputProperties,
    tiles: {
      ...createTilesetInputProperties.tiles,
      items: {
        ...createTilesetTileInputProperties,
        properties: {
          ...createTilesetTileProperties,
          sourceFrameIndex: { ...createTilesetTileProperties.sourceFrameIndex, default: 0 },
          collides: { ...createTilesetTileProperties.collides, default: false },
        },
      },
    },
    layout: { ...createTilesetInputProperties.layout, default: "input-order-row-major" },
  },
} as const;

const CreateTilesetResultTileSchema = z.object({
  tileIndex: z.number().int().min(0).max(255),
  tileName: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  collides: z.boolean(),
  terrain: TilesetTerrainSchema,
}).strict();

export const CreateTilesetResultSchema = z.object({
  tilesetAssetId: z.string().uuid(),
  name: z.string().regex(/^[a-z][a-z0-9_-]{1,47}$/),
  imagePath: z.string().regex(/^assets\/generated\/tilesets\/[0-9a-f-]{36}\.png$/),
  metadataPath: z.string().regex(/^assets\/generated\/tilesets\/[0-9a-f-]{36}\.json$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  tileSize: z.number().int().min(8).max(128),
  columns: z.number().int().min(1).max(16),
  rows: z.number().int().min(1).max(16),
  tiles: z.array(CreateTilesetResultTileSchema).min(1).max(256),
}).strict().superRefine((result, context) => {
  if (result.imagePath !== `assets/generated/tilesets/${result.tilesetAssetId}.png` ||
      result.metadataPath !== `assets/generated/tilesets/${result.tilesetAssetId}.json`) {
    context.addIssue({ code: "custom", path: ["imagePath"], message: "Tileset paths must be derived from the asset ID." });
  }
  if (result.rows !== Math.ceil(result.tiles.length / result.columns) || result.tiles.some((tile, index) => tile.tileIndex !== index)) {
    context.addIssue({ code: "custom", path: ["tiles"], message: "Tiles must use contiguous input-order row-major indices." });
  }
});

export const CreateTilesetMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  engine: z.literal("phaser-3.90.0"),
  tilesetAssetId: z.string().uuid(),
  name: z.string().regex(/^[a-z][a-z0-9_-]{1,47}$/),
  image: z.string().regex(/^[0-9a-f-]{36}\.png$/),
  imagePath: z.string().regex(/^assets\/generated\/tilesets\/[0-9a-f-]{36}\.png$/),
  metadataPath: z.string().regex(/^assets\/generated\/tilesets\/[0-9a-f-]{36}\.json$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  tileSize: z.number().int().min(8).max(128),
  tilewidth: z.number().int().min(8).max(128),
  tileheight: z.number().int().min(8).max(128),
  columns: z.number().int().min(1).max(16),
  rows: z.number().int().min(1).max(16),
  tilecount: z.number().int().min(1).max(256),
  margin: z.literal(0),
  spacing: z.literal(0),
  width: z.number().int().min(8).max(2_048),
  height: z.number().int().min(8).max(2_048),
  layout: z.literal("input-order-row-major"),
  tiles: z.array(z.object({
    id: z.number().int().min(0).max(255),
    type: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
    tileIndex: z.number().int().min(0).max(255),
    tileName: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
    collides: z.boolean(),
    terrain: TilesetTerrainSchema,
  }).strict()).min(1).max(256),
}).strict().superRefine((metadata, context) => {
  if (metadata.width !== metadata.columns * metadata.tileSize || metadata.height !== metadata.rows * metadata.tileSize ||
      metadata.rows !== Math.ceil(metadata.tiles.length / metadata.columns) ||
      metadata.image !== `${metadata.tilesetAssetId}.png` ||
      metadata.tilewidth !== metadata.tileSize || metadata.tileheight !== metadata.tileSize ||
      metadata.tilecount !== metadata.tiles.length || metadata.imagePath !== `assets/generated/tilesets/${metadata.tilesetAssetId}.png` ||
      metadata.metadataPath !== `assets/generated/tilesets/${metadata.tilesetAssetId}.json` ||
      metadata.tiles.some((tile, index) => tile.tileIndex !== index || tile.id !== index || tile.type !== tile.tileName)) {
    context.addIssue({ code: "custom", path: ["tiles"], message: "Tileset metadata dimensions or IDs are inconsistent." });
  }
});

export const CreateTilesetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  tilesets: z.array(z.object({
    tilesetAssetId: z.string().uuid(),
    name: z.string().regex(/^[a-z][a-z0-9_-]{1,47}$/),
    imagePath: z.string().regex(/^assets\/generated\/tilesets\/[0-9a-f-]{36}\.png$/),
    metadataPath: z.string().regex(/^assets\/generated\/tilesets\/[0-9a-f-]{36}\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    tileSize: z.number().int().min(8).max(128),
    columns: z.number().int().min(1).max(16),
    rows: z.number().int().min(1).max(16),
    tileCount: z.number().int().min(1).max(256),
  }).strict()).max(128),
}).strict().superRefine((manifest, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, entry] of manifest.tilesets.entries()) {
    if (ids.has(entry.tilesetAssetId) || names.has(entry.name) ||
        entry.imagePath !== `assets/generated/tilesets/${entry.tilesetAssetId}.png` ||
        entry.metadataPath !== `assets/generated/tilesets/${entry.tilesetAssetId}.json`) {
      context.addIssue({ code: "custom", path: ["tilesets", index], message: "Tileset manifest entries must have unique names and ID-derived paths." });
    }
    ids.add(entry.tilesetAssetId);
    names.add(entry.name);
  }
});

export const CreateTilesetResultJsonSchema = z.toJSONSchema(CreateTilesetResultSchema, { target: "draft-7" });

export type CreateTilesetInput = z.infer<typeof CreateTilesetInputSchema>;
export type CreateTilesetResult = z.infer<typeof CreateTilesetResultSchema>;
export type CreateTilesetMetadata = z.infer<typeof CreateTilesetMetadataSchema>;
export type CreateTilesetManifest = z.infer<typeof CreateTilesetManifestSchema>;

const CreateTilemapCellInputSchema = z.object({
  x: z.number().int().min(0).max(127),
  y: z.number().int().min(0).max(127),
  tileName: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
}).strict();

const CreateTilemapLayerInputSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
  visible: z.boolean().default(true),
  cells: z.array(CreateTilemapCellInputSchema).max(16_384),
}).strict();

const CreateTilemapInputBaseSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{1,47}$/),
  tilesetAssetId: z.string().uuid(),
  width: z.number().int().min(1).max(128),
  height: z.number().int().min(1).max(128),
  layers: z.array(CreateTilemapLayerInputSchema).min(1).max(8),
  collisionLayerNames: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/)).max(8).optional(),
}).strict();

export const CreateTilemapInputSchema = CreateTilemapInputBaseSchema.superRefine((input, context) => {
  const layerNames = new Set<string>();
  for (const [layerIndex, layer] of input.layers.entries()) {
    if (layerNames.has(layer.name)) {
      context.addIssue({ code: "custom", path: ["layers", layerIndex, "name"], message: "Layer names must be unique." });
    }
    layerNames.add(layer.name);
    const coordinates = new Set<string>();
    for (const [cellIndex, cell] of layer.cells.entries()) {
      const coordinate = `${cell.x},${cell.y}`;
      if (cell.x >= input.width || cell.y >= input.height) {
        context.addIssue({ code: "custom", path: ["layers", layerIndex, "cells", cellIndex], message: "Cell coordinates must fit inside the tilemap." });
      }
      if (coordinates.has(coordinate)) {
        context.addIssue({ code: "custom", path: ["layers", layerIndex, "cells", cellIndex], message: "A layer cannot contain duplicate coordinates." });
      }
      coordinates.add(coordinate);
    }
  }
  if (input.collisionLayerNames && new Set(input.collisionLayerNames).size !== input.collisionLayerNames.length) {
    context.addIssue({ code: "custom", path: ["collisionLayerNames"], message: "Collision layer names must be unique." });
  }
  if (input.collisionLayerNames?.some((name) => !layerNames.has(name))) {
    context.addIssue({ code: "custom", path: ["collisionLayerNames"], message: "Collision layers must reference a declared layer." });
  }
});

const createTilemapInputJson = z.toJSONSchema(CreateTilemapInputBaseSchema, { target: "draft-7" });
const createTilemapInputProperties = createTilemapInputJson.properties as Record<string, Record<string, unknown>>;
const createTilemapLayerItems = createTilemapInputProperties.layers?.items as Record<string, unknown>;
const createTilemapLayerProperties = createTilemapLayerItems.properties as Record<string, Record<string, unknown>>;
const createTilemapCellItems = createTilemapLayerProperties.cells?.items as Record<string, unknown>;
const createTilemapCellProperties = createTilemapCellItems.properties as Record<string, Record<string, unknown>>;
export const CreateTilemapInputJsonSchema = {
  ...createTilemapInputJson,
  properties: {
    ...createTilemapInputProperties,
    layers: {
      ...createTilemapInputProperties.layers,
      items: {
        ...createTilemapLayerItems,
        properties: {
          ...createTilemapLayerProperties,
          visible: { ...createTilemapLayerProperties.visible, default: true },
          cells: {
            ...createTilemapLayerProperties.cells,
            items: {
              ...createTilemapCellItems,
              properties: createTilemapCellProperties,
              additionalProperties: false,
            },
          },
        },
      },
    },
    collisionLayerNames: {
      ...createTilemapInputProperties.collisionLayerNames,
      uniqueItems: true,
    },
  },
} as const;

export const CreateTilemapResultSchema = z.object({
  tilemapAssetId: z.string().uuid(),
  tilesetAssetId: z.string().uuid(),
  path: z.string().regex(/^assets\/generated\/tilemaps\/[0-9a-f-]{36}\.json$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().min(1).max(128),
  height: z.number().int().min(1).max(128),
  tileSize: z.number().int().min(8).max(128),
  layerNames: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/)).min(1).max(8),
  cellCount: z.number().int().min(0).max(131_072),
  collisionTileNames: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/)).max(256),
  phaserFormat: z.literal("phaser-3-tilemap-json"),
}).strict().superRefine((result, context) => {
  if (result.path !== `assets/generated/tilemaps/${result.tilemapAssetId}.json` ||
      new Set(result.layerNames).size !== result.layerNames.length ||
      new Set(result.collisionTileNames).size !== result.collisionTileNames.length) {
    context.addIssue({ code: "custom", path: ["path"], message: "Tilemap paths and names must be stable and unique." });
  }
});

export const CreateTilemapResultJsonSchema = z.toJSONSchema(CreateTilemapResultSchema, { target: "draft-7" });

export const CreateTilemapManifestSchema = z.object({
  schemaVersion: z.literal(1),
  tilemaps: z.array(z.object({
    tilemapAssetId: z.string().uuid(),
    name: z.string().regex(/^[a-z][a-z0-9_-]{1,47}$/),
    tilesetAssetId: z.string().uuid(),
    path: z.string().regex(/^assets\/generated\/tilemaps\/[0-9a-f-]{36}\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().min(1).max(128),
    height: z.number().int().min(1).max(128),
    tileSize: z.number().int().min(8).max(128),
    layerNames: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/)).min(1).max(8),
    cellCount: z.number().int().min(0).max(131_072),
    collisionTileNames: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/)).max(256),
  }).strict()).max(128),
}).strict().superRefine((manifest, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, entry] of manifest.tilemaps.entries()) {
    if (ids.has(entry.tilemapAssetId) || names.has(entry.name) || entry.path !== `assets/generated/tilemaps/${entry.tilemapAssetId}.json`) {
      context.addIssue({ code: "custom", path: ["tilemaps", index], message: "Tilemap manifest entries must have unique names and ID-derived paths." });
    }
    ids.add(entry.tilemapAssetId);
    names.add(entry.name);
  }
});

export type CreateTilemapInput = z.infer<typeof CreateTilemapInputSchema>;
export type CreateTilemapResult = z.infer<typeof CreateTilemapResultSchema>;
export type CreateTilemapManifest = z.infer<typeof CreateTilemapManifestSchema>;

export const ASSET_INSPECTION_MAX_REPORT_BYTES = 24_000;
export const ASSET_INSPECTION_MAX_FINDINGS = 64;
export const ASSET_INSPECTION_MAX_JSON_BYTES = 1_048_576;
export const ASSET_INSPECTION_MAX_ENTRIES = 4_096;

const assetWorkspacePathPattern = "^public/assets/(?:generated|atlases|tilesets|tilemaps|animations)/(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}/)*[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}\\.(?:png|jpe?g|webp|gif|json)$";

export const AssetInspectionKindSchema = z.enum([
  "auto",
  "image",
  "atlas",
  "tileset",
  "tilemap",
  "animation",
  "manifest",
]);

export const AssetInspectionCheckSchema = z.enum([
  "decode",
  "dimensions",
  "alpha",
  "frame-grid",
  "atlas-references",
  "tileset-grid",
  "tilemap-bounds",
  "animation-frame-names",
  "phaser-runtime",
]);

const InspectAssetInputBaseSchema = z.object({
  assetId: z.string().uuid().optional(),
  workspacePath: z.string().min(1).max(300).regex(new RegExp(assetWorkspacePathPattern)).optional(),
  kind: AssetInspectionKindSchema,
  checks: z.array(AssetInspectionCheckSchema).min(1).max(9),
}).strict();

export const InspectAssetInputSchema = InspectAssetInputBaseSchema.superRefine((input, context) => {
  if (Number(input.assetId !== undefined) + Number(input.workspacePath !== undefined) !== 1) {
    context.addIssue({ code: "custom", message: "Provide exactly one assetId or workspacePath." });
  }
  if (new Set(input.checks).size !== input.checks.length) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Checks must be unique." });
  }
});

export const AssetInspectionFindingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string().regex(/^[a-z0-9_]{1,80}$/),
  message: z.string().max(500),
  path: z.string().max(512).optional(),
}).strict();

export const InspectAssetResultSchema = z.object({
  status: z.enum(["valid", "invalid", "needs_review"]),
  kind: z.enum(["image", "atlas", "tileset", "tilemap", "animation", "manifest"]),
  assetId: z.string().uuid().optional(),
  path: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  dimensions: z.object({
    width: z.number().int().min(1).max(4_096),
    height: z.number().int().min(1).max(4_096),
  }).strict().optional(),
  frameCount: z.number().int().min(0).max(ASSET_INSPECTION_MAX_ENTRIES).optional(),
  findings: z.array(AssetInspectionFindingSchema).max(ASSET_INSPECTION_MAX_FINDINGS),
}).strict();

const inputJsonSchema = z.toJSONSchema(InspectAssetInputBaseSchema, { target: "draft-7" });
const inputProperties = inputJsonSchema.properties as Record<string, Record<string, unknown>>;

/** Draft-7 contract sent to the provider, including the source exclusivity constraint. */
export const InspectAssetInputJsonSchema = {
  ...inputJsonSchema,
  properties: {
    ...inputProperties,
    checks: { ...inputProperties.checks, uniqueItems: true },
  },
  oneOf: [
    { required: ["assetId"], not: { required: ["workspacePath"] } },
    { required: ["workspacePath"], not: { required: ["assetId"] } },
  ],
} as const;

export const InspectAssetResultJsonSchema = z.toJSONSchema(InspectAssetResultSchema, { target: "draft-7" });

export type InspectAssetInput = z.infer<typeof InspectAssetInputSchema>;
export type AssetInspectionKind = Exclude<z.infer<typeof AssetInspectionKindSchema>, "auto">;
export type AssetInspectionCheck = z.infer<typeof AssetInspectionCheckSchema>;
export type AssetInspectionFinding = z.infer<typeof AssetInspectionFindingSchema>;
export type InspectAssetResult = z.infer<typeof InspectAssetResultSchema>;
