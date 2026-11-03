import type Phaser from "phaser";

export type GeneratedTilesetMetadata = Readonly<{
  schemaVersion: 1;
  engine: "phaser-3.90.0";
  tilesetAssetId: string;
  name: string;
  image: string;
  imagePath: string;
  metadataPath: string;
  sha256: string;
  tileSize: number;
  tilewidth: number;
  tileheight: number;
  columns: number;
  rows: number;
  tilecount: number;
  margin: 0;
  spacing: 0;
  width: number;
  height: number;
  layout: "input-order-row-major";
  tiles: readonly Readonly<{ id: number; type: string; tileIndex: number; tileName: string; collides: boolean; terrain: string }>[];
}>;

export type GeneratedTilesetBinding = Readonly<{
  tileset: Phaser.Tilemaps.Tileset;
  name: string;
  firstgid: number;
  localIndexByName: Readonly<Record<string, number>>;
  globalIndexByName: Readonly<Record<string, number>>;
  collisionLocalIndices: readonly number[];
  collisionGids: readonly number[];
  terrainByLocalIndex: Readonly<Record<number, string>>;
}>;

/** Validate the private generated-tileset descriptor before it reaches Phaser. */
export function parseGeneratedTilesetMetadata(value: unknown): GeneratedTilesetMetadata | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.engine !== "phaser-3.90.0" ||
      typeof value.tilesetAssetId !== "string" || !uuidPattern.test(value.tilesetAssetId) ||
      typeof value.name !== "string" || !/^[a-z][a-z0-9_-]{1,47}$/.test(value.name) ||
      value.image !== `${value.tilesetAssetId}.png` ||
      typeof value.imagePath !== "string" || value.imagePath !== `assets/generated/tilesets/${value.tilesetAssetId}.png` ||
      typeof value.metadataPath !== "string" || value.metadataPath !== `assets/generated/tilesets/${value.tilesetAssetId}.json` ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      value.layout !== "input-order-row-major" || !isIntegerIn(value.tileSize, 8, 128) ||
      !isIntegerIn(value.columns, 1, 16) || !isIntegerIn(value.rows, 1, 16) ||
      value.width !== value.columns * value.tileSize || value.height !== value.rows * value.tileSize ||
      value.tilewidth !== value.tileSize || value.tileheight !== value.tileSize ||
      value.margin !== 0 || value.spacing !== 0 ||
      !Array.isArray(value.tiles) || value.tiles.length < 1 || value.tiles.length > 256 ||
      value.tilecount !== value.tiles.length ||
      value.rows !== Math.ceil(value.tiles.length / value.columns)) return undefined;
  const tiles = value.tiles;
  const names = new Set<string>();
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    if (!isRecord(tile) || tile.id !== index || tile.tileIndex !== index || typeof tile.type !== "string" ||
        tile.type !== tile.tileName || typeof tile.tileName !== "string" ||
        !/^[a-z][a-z0-9_-]{0,47}$/.test(tile.tileName) || names.has(tile.tileName) ||
        typeof tile.collides !== "boolean" ||
        !["ground", "wall", "water", "hazard", "decoration", "unknown"].includes(String(tile.terrain))) return undefined;
    names.add(tile.tileName);
  }
  return value as unknown as GeneratedTilesetMetadata;
}

/** Attach the loaded texture and copy stable tile properties into Phaser's local tile indices. */
export function addGeneratedTileset(
  map: Phaser.Tilemaps.Tilemap,
  metadata: GeneratedTilesetMetadata,
  imageKey = metadata.name,
  firstgid = 1,
): GeneratedTilesetBinding {
  if (!Number.isSafeInteger(firstgid) || firstgid < 1 || firstgid + metadata.tiles.length - 1 > 0x1fffffff) {
    throw new RangeError("generated_tileset_firstgid_invalid");
  }
  const tileset = map.addTilesetImage(
    metadata.name,
    imageKey,
    metadata.tileSize,
    metadata.tileSize,
    0,
    0,
    firstgid,
  );
  if (!tileset) throw new Error("generated_tileset_texture_missing");
  tileset.tileProperties = Object.fromEntries(metadata.tiles.map((tile) => [String(tile.tileIndex), {
    name: tile.tileName,
    collides: tile.collides,
    terrain: tile.terrain,
  }]));
  const localIndexByName = Object.fromEntries(metadata.tiles.map((tile) => [tile.tileName, tile.tileIndex]));
  const globalIndexByName = Object.fromEntries(metadata.tiles.map((tile) => [tile.tileName, firstgid + tile.tileIndex]));
  const terrainByLocalIndex = Object.fromEntries(metadata.tiles.map((tile) => [tile.tileIndex, tile.terrain]));
  const collisionLocalIndices = metadata.tiles.filter((tile) => tile.collides).map((tile) => tile.tileIndex);
  const collisionGids = collisionLocalIndices.map((index) => firstgid + index);
  return { tileset, name: metadata.name, firstgid, localIndexByName, globalIndexByName, collisionLocalIndices, collisionGids, terrainByLocalIndex };
}

/** Apply only collisions declared on the tiles; terrain remains available through Tile.properties. */
export function applyGeneratedTilesetCollisions(
  layer: Phaser.Tilemaps.TilemapLayer,
  binding: GeneratedTilesetBinding,
): Phaser.Tilemaps.TilemapLayer {
  if (binding.collisionGids.length) layer.setCollision([...binding.collisionGids]);
  return layer;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isIntegerIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
