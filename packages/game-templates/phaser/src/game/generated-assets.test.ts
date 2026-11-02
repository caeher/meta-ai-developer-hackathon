import { describe, expect, it } from "vitest";
import { parseGeneratedAssetManifest } from "./generated-assets";

const id = "85b3d197-fbb7-4ef6-b796-7c89687d2438";
const validAsset = {
  assetId: id,
  key: `generated-${id}`,
  path: `assets/generated/${id}.png`,
  assetType: "sprite",
  frameColumns: 4,
  frameRows: 2,
  frameWidth: 32,
  frameHeight: 48,
};

describe("generated Phaser asset manifest", () => {
  it("accepts bounded local PNG paths and sprite frame metadata", () => {
    expect(parseGeneratedAssetManifest({ schemaVersion: 1, assets: [validAsset] })).toEqual([validAsset]);
  });

  it("rejects remote paths, duplicate IDs, malformed IDs, and oversized manifests", () => {
    expect(parseGeneratedAssetManifest({ schemaVersion: 1, assets: [{ ...validAsset, path: "https://evil.invalid/asset.png" }] })).toBeUndefined();
    expect(parseGeneratedAssetManifest({ schemaVersion: 1, assets: [validAsset, validAsset] })).toBeUndefined();
    expect(parseGeneratedAssetManifest({ schemaVersion: 1, assets: [{ ...validAsset, assetId: "../escape" }] })).toBeUndefined();
    expect(parseGeneratedAssetManifest({ schemaVersion: 1, assets: Array.from({ length: 129 }, () => validAsset) })).toBeUndefined();
  });
});
