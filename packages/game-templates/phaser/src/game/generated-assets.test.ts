import { describe, expect, it } from "vitest";
import { parseGeneratedAssetManifest, parseGeneratedSpritesheetAtlas } from "./generated-assets";

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

describe("generated Phaser spritesheet atlas", () => {
  const validAtlas = {
    frames: {
      run_0: {
        frame: { x: 1, y: 1, w: 8, h: 8 },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: 8, h: 8 },
        sourceSize: { w: 8, h: 8 },
        pivot: { x: 0.5, y: 1 },
      },
      run_1: {
        frame: { x: 11, y: 1, w: 10, h: 8 },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: 10, h: 8 },
        sourceSize: { w: 10, h: 8 },
        pivot: { x: 0.5, y: 1 },
      },
    },
    meta: {
      schemaVersion: 1,
      engine: "phaser-3.90.0",
      atlasFormat: "phaser-json-hash",
      image: "85b3d197-fbb7-4ef6-b796-7c89687d2438.png",
      size: { w: 22, h: 10 },
      sha256: "a".repeat(64),
      provenance: [
        { frameName: "run_0", sourceAssetId: id, sourceFrameIndex: 0, sourceSha256: "b".repeat(64) },
        { frameName: "run_1", sourceAssetId: id, sourceFrameIndex: 1, sourceSha256: "b".repeat(64) },
      ],
    },
  };

  it("accepts ordered Phaser Hash frames with bounded pivots and source provenance", () => {
    expect(parseGeneratedSpritesheetAtlas(validAtlas)).toMatchObject({
      image: "85b3d197-fbb7-4ef6-b796-7c89687d2438.png",
      width: 22,
      height: 10,
      frameNames: ["run_0", "run_1"],
      frames: {
        run_0: { x: 1, y: 1, width: 8, height: 8, pivotX: 0.5, pivotY: 1 },
        run_1: { x: 11, y: 1, width: 10, height: 8, pivotX: 0.5, pivotY: 1 },
      },
    });
  });

  it.each([
    ["out-of-bounds frame", { ...validAtlas, frames: { ...validAtlas.frames, run_1: { ...validAtlas.frames.run_1, frame: { x: 15, y: 1, w: 10, h: 8 } } } }],
    ["overlapping frames", { ...validAtlas, frames: { ...validAtlas.frames, run_1: { ...validAtlas.frames.run_1, frame: { x: 7, y: 1, w: 10, h: 8 } } } }],
    ["invalid pivot", { ...validAtlas, frames: { ...validAtlas.frames, run_1: { ...validAtlas.frames.run_1, pivot: { x: 1.1, y: 1 } } } }],
    ["missing provenance", { ...validAtlas, meta: { ...validAtlas.meta, provenance: validAtlas.meta.provenance.slice(0, 1) } }],
  ])("rejects %s", (_label, atlas) => {
    expect(parseGeneratedSpritesheetAtlas(atlas)).toBeUndefined();
  });
});
