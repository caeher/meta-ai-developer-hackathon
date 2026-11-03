import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  InspectAssetInputJsonSchema,
  InspectAssetInputSchema,
  InspectAssetResultJsonSchema,
  InspectAssetResultSchema,
  type InspectAssetInput,
} from "@meta-game/contracts";
import { OwnedResourceNotFoundError, type VerifiedIdentityContext } from "@meta-game/db";
import { createInspectAssetTool, inspectAsset, type AssetInspectionSource } from "../../apps/worker/src/assets/inspect-asset";

const checks = ["decode", "dimensions", "alpha", "frame-grid", "atlas-references", "tileset-grid", "tilemap-bounds", "animation-frame-names"] as const;
const projectId = "00000000-0000-4000-8000-000000000301";
const assetId = "00000000-0000-4000-8000-000000000302";

async function png(width: number, height: number, color = { r: 31, g: 190, b: 112, alpha: 1 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

function input(workspacePath: string, kind: InspectAssetInput["kind"] = "auto"): InspectAssetInput {
  return InspectAssetInputSchema.parse({ workspacePath, kind, checks: [...checks] });
}

function fixtureSource(files: Record<string, string | Uint8Array>, stored?: { asset: { id: string; projectId: string; contentType: string; sizeBytes: number; sha256: string; metadata: Record<string, unknown> }; body: Uint8Array }): AssetInspectionSource {
  return {
    async readWorkspaceText(path) {
      const value = files[path];
      if (value === undefined) throw new Error("file_not_found");
      return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
    },
    async readWorkspaceBinary(path) {
      const value = files[path];
      if (!(value instanceof Uint8Array)) throw new Error("file_not_found");
      return value;
    },
    async readStoredAsset(id) {
      if (!stored || id !== stored.asset.id) throw new OwnedResourceNotFoundError();
      return stored;
    },
  };
}

function json(value: unknown): string { return JSON.stringify(value); }
function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

describe("inspect_asset contract and read-only inspector", () => {
  it("exports a Draft-7 JSON Schema that enforces the same source and bounds as Zod", () => {
    const valid = { workspacePath: "public/assets/generated/hero.png", kind: "image", checks: ["decode"] };
    expect(InspectAssetInputSchema.safeParse(valid).success).toBe(true);
    expect(InspectAssetInputSchema.safeParse({ ...valid, assetId }).success).toBe(false);
    expect(InspectAssetInputSchema.safeParse({ ...valid, workspacePath: "public/assets/generated/../hero.png" }).success).toBe(false);
    expect(InspectAssetInputSchema.safeParse({ ...valid, checks: ["decode", "decode"] }).success).toBe(false);
    expect((InspectAssetInputJsonSchema.properties as Record<string, Record<string, unknown>>).checks?.uniqueItems).toBe(true);
    expect(InspectAssetInputJsonSchema).toMatchObject({
      "$schema": "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      required: ["kind", "checks"],
      oneOf: [
        { required: ["assetId"], not: { required: ["workspacePath"] } },
        { required: ["workspacePath"], not: { required: ["assetId"] } },
      ],
    });
    expect(jsonSchemaAccepts(InspectAssetInputJsonSchema as unknown as Record<string, unknown>, valid)).toBe(true);
    expect(jsonSchemaAccepts(InspectAssetInputJsonSchema as unknown as Record<string, unknown>, { ...valid, assetId })).toBe(false);
    expect(jsonSchemaAccepts(InspectAssetInputJsonSchema as unknown as Record<string, unknown>, { ...valid, checks: ["decode", "decode"] })).toBe(false);
    expect(jsonSchemaAccepts(InspectAssetInputJsonSchema as unknown as Record<string, unknown>, { ...valid, workspacePath: "https://example.invalid/image.png" })).toBe(false);
    expect(InspectAssetResultJsonSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(InspectAssetResultSchema.safeParse({ status: "valid", kind: "image", path: "hero.png", findings: [] }).success).toBe(true);
  });

  it("decodes real image bytes and returns dimensions, SHA-256 and bounded findings", async () => {
    const image = await png(32, 16);
    const result = await inspectAsset(input("public/assets/generated/hero.png"), fixtureSource({ "public/assets/generated/hero.png": image }));
    expect(result).toMatchObject({ status: "valid", kind: "image", dimensions: { width: 32, height: 16 }, frameCount: 1, sha256: digest(image), findings: [] });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(24_000);
  });

  it("rejects corrupt bytes, image dimensions beyond the product limit, and storage metadata drift", async () => {
    const badBytes = Buffer.from("not-an-image");
    const bad = await inspectAsset(input("public/assets/generated/bad.png"), fixtureSource({ "public/assets/generated/bad.png": badBytes }));
    expect(bad.status).toBe("invalid");
    expect(bad.findings.map((finding) => finding.code)).toContain("image_decode_failed");

    const tooLarge = await png(2_100, 4);
    const large = await inspectAsset(input("public/assets/generated/large.png"), fixtureSource({ "public/assets/generated/large.png": tooLarge }));
    expect(large.findings.map((finding) => finding.code)).toContain("image_dimensions_exceeded");

    const goodBytes = await png(16, 16);
    const stored = {
      asset: { id: assetId, projectId, contentType: "image/jpeg", sizeBytes: goodBytes.byteLength, sha256: digest(goodBytes), metadata: { sha256: "0".repeat(64), width: 15, height: 16 } },
      body: goodBytes,
    };
    const result = await inspectAsset(InspectAssetInputSchema.parse({ assetId, kind: "auto", checks: ["decode", "dimensions"] }), fixtureSource({}, stored));
    expect(result.status).toBe("invalid");
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "image_mime_mismatch", "storage_metadata_checksum_mismatch", "storage_metadata_dimensions_mismatch",
    ]));

    const malformed = await inspectAsset(input("public/assets/animations/bad.json"), fixtureSource({
      "public/assets/animations/bad.json": "{not-json",
    }));
    expect(malformed.status).toBe("invalid");
    expect(malformed.findings.map((finding) => finding.code)).toContain("json_malformed");
  });

  it("checks every atlas frame rectangle, overlap, duplicate name and normalized pivot", async () => {
    const texture = await png(32, 16);
    const atlas = {
      frames: {
        idle_0: { frame: { x: 0, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 1 } },
        idle_1: { frame: { x: 16, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 1 } },
      },
      meta: { image: "hero.png", size: { w: 32, h: 16 }, format: "RGBA8888", scale: "1" },
    };
    const valid = await inspectAsset(input("public/assets/atlases/hero.json", "atlas"), fixtureSource({
      "public/assets/atlases/hero.json": json(atlas), "public/assets/atlases/hero.png": texture,
    }));
    expect(valid).toMatchObject({ status: "valid", kind: "atlas", dimensions: { width: 32, height: 16 }, frameCount: 2 });

    const invalid = await inspectAsset(input("public/assets/atlases/bad.json", "atlas"), fixtureSource({
      "public/assets/atlases/bad.json": json({
        ...atlas,
        frames: [
          { filename: "overlap-a", frame: { x: 24, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 1 } },
          { filename: "overlap-b", frame: { x: 16, y: 0, w: 16, h: 16 }, pivot: { x: 1.5, y: 1 } },
          { filename: "overlap-a", frame: { x: 0, y: 0, w: 16, h: 16 }, pivot: { x: 0.5, y: 1 } },
        ],
      }),
      "public/assets/atlases/hero.png": texture,
    }));
    expect(invalid.status).toBe("invalid");
    expect(invalid.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "atlas_frame_name_invalid", "atlas_rect_out_of_bounds", "atlas_pivot_out_of_bounds", "atlas_frame_overlap",
    ]));
  });

  it("validates ordered animation frame names and the declared Phaser frame rate", async () => {
    const atlasPath = "public/assets/atlases/hero.json";
    const atlas = { frames: { run_0: { frame: { x: 0, y: 0, w: 16, h: 16 } }, run_1: { frame: { x: 16, y: 0, w: 16, h: 16 } } }, meta: { image: "hero.png", size: { w: 32, h: 16 } } };
    const source = fixtureSource({
      "public/assets/animations/run.json": json({ key: "run", atlasPath: "../atlases/hero.json", fps: 8, frames: ["run_1", "run_0"] }),
      [atlasPath]: json(atlas),
      "public/assets/atlases/hero.png": await png(32, 16),
    });
    const valid = await inspectAsset(input("public/assets/animations/run.json", "animation"), source);
    expect(valid).toMatchObject({ status: "valid", frameCount: 2 });

    const invalid = await inspectAsset(input("public/assets/animations/run.json", "animation"), fixtureSource({
      "public/assets/animations/run.json": json({ key: "run", atlasPath: "../atlases/hero.json", fps: 0, frames: ["run_0", "missing"] }),
      [atlasPath]: json(atlas),
      "public/assets/atlases/hero.png": await png(32, 16),
    }));
    expect(invalid.status).toBe("invalid");
    expect(invalid.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["animation_fps_invalid", "animation_frame_missing"]));
  });

  it("rejects atlas references to external URLs without attempting a request", async () => {
    const base = fixtureSource({
      "public/assets/atlases/external.json": json({ frames: {}, meta: { image: "https://assets.example.invalid/hero.png", size: { w: 16, h: 16 } } }),
    });
    const binaryReads: string[] = [];
    const source: AssetInspectionSource = {
      ...base,
      async readWorkspaceBinary(path, signal) {
        binaryReads.push(path);
        return base.readWorkspaceBinary(path, signal);
      },
    };
    const result = await inspectAsset(input("public/assets/atlases/external.json", "atlas"), source);
    expect(result.status).toBe("invalid");
    expect(result.findings.map((finding) => finding.code)).toContain("atlas_reference_invalid");
    expect(binaryReads).toEqual([]);
  });

  it("validates tile grids, tile ranges, duplicate coordinates and map bounds", async () => {
    const texture = await png(32, 16);
    const tileset = { name: "terrain", image: "terrain.png", tilewidth: 16, tileheight: 16, tilecount: 2, columns: 2, tiles: [{ id: 1, collides: true }] };
    const files = {
      "public/assets/tilesets/terrain.json": json(tileset),
      "public/assets/tilesets/terrain.png": texture,
    };
    const validTiles = await inspectAsset(input("public/assets/tilesets/terrain.json", "tileset"), fixtureSource(files));
    expect(validTiles).toMatchObject({ status: "valid", kind: "tileset", dimensions: { width: 32, height: 16 }, frameCount: 2 });

    const badTiles = await inspectAsset(input("public/assets/tilesets/bad.json", "tileset"), fixtureSource({
      "public/assets/tilesets/bad.json": json({ ...tileset, columns: 3, tilecount: 4, tiles: [{ id: 8, collides: true }] }),
      "public/assets/tilesets/terrain.png": texture,
    }));
    expect(badTiles.status).toBe("invalid");
    expect(badTiles.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["tileset_count_mismatch", "tileset_tile_out_of_range"]));

    const map = { schemaVersion: 1, width: 2, height: 2, tileWidth: 16, tileHeight: 16, tilesetPath: "../tilesets/terrain.json", layers: [{ name: "ground", collides: true, tiles: [{ x: 0, y: 1, index: 1 }] }] };
    const validMap = await inspectAsset(input("public/assets/tilemaps/level.json", "tilemap"), fixtureSource({
      "public/assets/tilemaps/level.json": json(map), ...files,
    }));
    expect(validMap).toMatchObject({ status: "valid", kind: "tilemap", dimensions: { width: 32, height: 32 }, frameCount: 1 });

    const invalidMap = await inspectAsset(input("public/assets/tilemaps/bad.json", "tilemap"), fixtureSource({
      "public/assets/tilemaps/bad.json": json({ ...map, layers: [{ name: "ground", collides: true, tiles: [{ x: 0, y: 0, index: 8 }, { x: 0, y: 0, index: 1 }, { x: 2, y: 0, index: 1 }] }] }),
      ...files,
    }));
    expect(invalidMap.status).toBe("invalid");
    expect(invalidMap.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "tilemap_duplicate_coordinates", "tilemap_coordinate_out_of_bounds", "tilemap_tile_out_of_range",
    ]));

    const oversizedMap = await inspectAsset(input("public/assets/tilemaps/oversized.json", "tilemap"), fixtureSource({
      "public/assets/tilemaps/oversized.json": json({ ...map, width: 1, height: 1, tileWidth: 4_097, layers: [{ tiles: [{ x: 0, y: 0, index: 1 }] }] }),
      ...files,
    }));
    expect(oversizedMap.findings.map((finding) => finding.code)).toContain("tilemap_dimensions_exceeded");
  });

  it("checks manifest references and returns needs_review when browser runtime confirmation is requested", async () => {
    const id = "00000000-0000-4000-8000-000000000399";
    const image = await png(32, 16);
    const manifest = { schemaVersion: 1, assets: [{ assetId: id, key: `generated-${id}`, path: `assets/generated/${id}.png`, assetType: "sprite", frameColumns: 2, frameRows: 1, frameWidth: 16, frameHeight: 16 }] };
    const result = await inspectAsset(input("public/assets/generated/manifest.json", "manifest"), fixtureSource({
      "public/assets/generated/manifest.json": json(manifest), [`public/${manifest.assets[0]!.path}`]: image,
    }));
    expect(result).toMatchObject({ status: "valid", kind: "manifest", dimensions: { width: 32, height: 16 }, frameCount: 1 });

    const review = await inspectAsset(input("public/assets/animations/run.json", "animation"), fixtureSource({
      "public/assets/animations/run.json": json({ key: "run", fps: 6, frames: ["run_0"] }),
    }));
    expect(review.status).toBe("needs_review");
    expect(review.findings.map((finding) => finding.code)).toContain("animation_atlas_unspecified");

    const runtimeReview = await inspectAsset({ workspacePath: "public/assets/atlases/hero.json", kind: "atlas", checks: [...checks, "phaser-runtime"] }, fixtureSource({
      "public/assets/atlases/hero.json": json({ frames: { idle: { frame: { x: 0, y: 0, w: 16, h: 16 } } }, meta: { image: "hero.png", size: { w: 16, h: 16 } } }),
      "public/assets/atlases/hero.png": await png(16, 16),
    }));
    expect(runtimeReview.status).toBe("needs_review");
    expect(runtimeReview.findings.map((finding) => finding.code)).toContain("runtime_preview_required");
  });

  it("returns the same not-found error for an asset outside the run project", async () => {
    const bytes = await png(8, 8);
    const identity = {} as VerifiedIdentityContext;
    const claim = { runId: "00000000-0000-4000-8000-000000000303", ownerUserId: "user_test", projectId, fencingToken: 1 };
    const context = { claim, projectId, signal: new AbortController().signal };
    const sandbox = {
      async readFile() { return { path: "", content: "" }; },
      async readBinaryFile() { return bytes; },
    } as never;
    const storage = {
      async read() {
        return { asset: { id: assetId, projectId: "00000000-0000-4000-8000-000000000304", contentType: "image/png", sizeBytes: bytes.byteLength, sha256: digest(bytes), metadata: {} }, body: bytes };
      },
    };
    const inspect = createInspectAssetTool({ sandbox, storage, identity: async () => identity });
    await expect(inspect({ assetId, kind: "image", checks: ["decode"] }, context)).rejects.toMatchObject({ name: "OwnedResourceNotFoundError", message: "Recurso no encontrado" });
  });
});

function jsonSchemaAccepts(schema: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(schema.oneOf)) {
    const matching = schema.oneOf.filter((branch) => isRecord(branch) && jsonSchemaAccepts(branch, value));
    if (matching.length !== 1) return false;
  }
  if (schema.not && isRecord(schema.not) && jsonSchemaAccepts(schema.not, value)) return false;
  if (Array.isArray(schema.required)) {
    if (!isRecord(value) || schema.required.some((key) => typeof key === "string" && !(key in value))) return false;
  }
  if (schema.type === "object") {
    if (!isRecord(value)) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
    return Object.entries(value).every(([key, item]) => !properties[key] || isRecord(properties[key]) && jsonSchemaAccepts(properties[key] as Record<string, unknown>, item));
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || typeof schema.minItems === "number" && value.length < schema.minItems || typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    return !isRecord(schema.items) || value.every((item) => jsonSchemaAccepts(schema.items as Record<string, unknown>, item));
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
