import { describe, expect, it } from "vitest";
import { parseGeneratedTilesetMetadata } from "./tilesets";

const id = "d6a3b5a2-524a-4c25-a82a-9ae399190001";
const metadata = {
  schemaVersion: 1,
  engine: "phaser-3.90.0",
  tilesetAssetId: id,
  name: "forest_tiles",
  image: `${id}.png`,
  imagePath: `assets/generated/tilesets/${id}.png`,
  metadataPath: `assets/generated/tilesets/${id}.json`,
  sha256: "a".repeat(64),
  tileSize: 16,
  tilewidth: 16,
  tileheight: 16,
  columns: 2,
  rows: 1,
  tilecount: 2,
  margin: 0,
  spacing: 0,
  width: 32,
  height: 16,
  layout: "input-order-row-major",
  tiles: [
    { id: 0, type: "water", tileIndex: 0, tileName: "water", collides: false, terrain: "water" },
    { id: 1, type: "ground", tileIndex: 1, tileName: "ground", collides: true, terrain: "ground" },
  ],
};

describe("generated Phaser tileset metadata", () => {
  it("accepts bounded local descriptors with stable row-major indices", () => {
    expect(parseGeneratedTilesetMetadata(metadata)).toEqual(metadata);
  });

  it("rejects remote paths, duplicate names, missing indices and mismatched image dimensions", () => {
    expect(parseGeneratedTilesetMetadata({ ...metadata, imagePath: "https://example.invalid/tiles.png" })).toBeUndefined();
    expect(parseGeneratedTilesetMetadata({ ...metadata, tiles: [metadata.tiles[0], { ...metadata.tiles[1], tileName: "water" }] })).toBeUndefined();
    expect(parseGeneratedTilesetMetadata({ ...metadata, tiles: [metadata.tiles[0], { ...metadata.tiles[1], tileIndex: 7 }] })).toBeUndefined();
    expect(parseGeneratedTilesetMetadata({ ...metadata, width: 33 })).toBeUndefined();
  });
});
