import type Phaser from "phaser";
import {
  addGeneratedTileset,
  applyGeneratedTilesetCollisions,
  type GeneratedTilesetMetadata,
} from "./tilesets";

export type GeneratedTilemapLayer = Readonly<{
  name: string;
  visible: boolean;
  collides: boolean;
  layer: Phaser.Tilemaps.TilemapLayer;
}>;

export type GeneratedTilemapRuntime = Readonly<{
  map: Phaser.Tilemaps.Tilemap;
  layers: readonly GeneratedTilemapLayer[];
  tileset: ReturnType<typeof addGeneratedTileset>;
}>;

/** Load the Phaser 3.90 Tiled JSON after the caller preloads its JSON, image, and private tileset metadata. */
export function createGeneratedTilemap(
  scene: Phaser.Scene,
  mapKey: string,
  tilesetMetadata: GeneratedTilesetMetadata,
  imageKey = `generated-tileset-${tilesetMetadata.tilesetAssetId}`,
): GeneratedTilemapRuntime {
  if (!scene.cache.tilemap.exists(mapKey)) throw new Error("generated_tilemap_missing");
  if (!scene.textures.exists(imageKey)) throw new Error("generated_tilemap_image_missing");
  const map = scene.make.tilemap({ key: mapKey });
  // Phaser.Tilemaps.Formats.TILED_JSON is the stable numeric format 1.
  if (map.format !== 1 || map.width < 1 || map.height < 1 ||
      map.width > 128 || map.height > 128 || map.tileWidth !== tilesetMetadata.tileSize || map.tileHeight !== tilesetMetadata.tileSize) {
    throw new Error("generated_tilemap_invalid");
  }
  if (readProperty(map.properties, "tilesetAssetId") !== tilesetMetadata.tilesetAssetId) {
    throw new Error("generated_tilemap_tileset_reference_invalid");
  }
  if (!Array.isArray(map.layers) || map.layers.length < 1 || map.layers.length > 8 ||
      map.layers.some((layer) => layer.width !== map.width || layer.height !== map.height || layer.data.length !== map.height || layer.data.some((row) => row.length !== map.width))) {
    throw new Error("generated_tilemap_layers_invalid");
  }
  if (new Set(map.layers.map(({ name }) => name)).size !== map.layers.length) throw new Error("generated_tilemap_layers_invalid");

  const tilesetData = map.tilesets.find(({ name }) => name === tilesetMetadata.name && name.length > 0);
  if (!tilesetData || tilesetData.firstgid < 1 || tilesetData.tileWidth !== tilesetMetadata.tileSize ||
      tilesetData.tileHeight !== tilesetMetadata.tileSize || tilesetData.total !== tilesetMetadata.tilecount) {
    throw new Error("generated_tilemap_tileset_missing");
  }
  if (tilesetData.firstgid !== 1) throw new Error("generated_tilemap_firstgid_invalid");
  for (const layer of map.layers) {
    for (const row of layer.data) {
      for (const tile of row) {
        if (tile.index < -1 || (tile.index >= 0 && (tile.index < tilesetData.firstgid || tile.index >= tilesetData.firstgid + tilesetMetadata.tilecount))) {
          throw new Error("generated_tilemap_gid_out_of_range");
        }
      }
    }
  }

  const binding = addGeneratedTileset(map, tilesetMetadata, imageKey, tilesetData.firstgid);
  const layers: GeneratedTilemapLayer[] = map.layers.map((layerData) => {
    const layer = map.createLayer(layerData.name, binding.tileset, 0, 0);
    if (!layer) throw new Error("generated_tilemap_layer_missing");
    layer.setVisible(layerData.visible);
    const collides = hasBooleanProperty(layerData.properties, "collides");
    if (collides) applyGeneratedTilesetCollisions(layer, binding);
    return { name: layerData.name, visible: layerData.visible, collides, layer };
  });
  return { map, layers, tileset: binding };
}

function hasBooleanProperty(properties: object[], name: string): boolean {
  return properties.some((property) => {
    if (typeof property !== "object" || property === null || Array.isArray(property)) return false;
    const record = property as Record<string, unknown>;
    return record.name === name && record.value === true;
  });
}

function readProperty(properties: object | object[] | null | undefined, name: string): unknown {
  if (Array.isArray(properties)) {
    const found = properties.find((property) => typeof property === "object" && property !== null &&
      !Array.isArray(property) && (property as Record<string, unknown>).name === name);
    return found && typeof found === "object" && "value" in found ? (found as { value: unknown }).value : undefined;
  }
  if (typeof properties === "object" && properties !== null) return (properties as Record<string, unknown>)[name];
  return undefined;
}
