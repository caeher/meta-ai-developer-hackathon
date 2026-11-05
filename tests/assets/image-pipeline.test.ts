import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ImageGenerationBriefSchema, type MetaImageResult } from "@meta-game/contracts";
import { processGeneratedImage } from "../../apps/worker/src/assets/image-pipeline";

const model = "muse-image-1.0";

function brief(overrides: Record<string, unknown> = {}) {
  return ImageGenerationBriefSchema.parse({
    assetType: "sprite",
    description: "A blue fox hero facing right",
    style: "crisp pixel art",
    view: "side",
    palette: ["#2468ac"],
    transparentBackground: false,
    frameColumns: 1,
    frameRows: 1,
    tileable: false,
    ...overrides,
  });
}

async function image(options: {
  width?: number;
  height?: number;
  channels?: 3 | 4;
  background?: { r: number; g: number; b: number; alpha?: number };
  format?: "png" | "jpeg" | "webp";
} = {}): Promise<MetaImageResult> {
  const width = options.width ?? 32;
  const height = options.height ?? 16;
  const channels = options.channels ?? 4;
  const bytes = await sharp({
    create: {
      width,
      height,
      channels,
      background: options.background ?? { r: 30, g: 120, b: 220, alpha: 1 },
    },
  })[options.format ?? "png"]().toBuffer();
  const mimeType = options.format === "jpeg" ? "image/jpeg" : options.format === "webp" ? "image/webp" : "image/png";
  return { bytes, mimeType, width, height, model, responseId: "resp_image_fixture" };
}

async function transparentPng(width = 32, height = 16): Promise<MetaImageResult> {
  const bytes = await sharp({
    create: { width, height, channels: 4, background: { r: 30, g: 120, b: 220, alpha: 0 } },
  }).png().toBuffer();
  return { bytes, mimeType: "image/png", width, height, model, responseId: "resp_image_fixture" };
}

describe("generated image validation pipeline", () => {
  it("normalizes PNGs, slices the requested frame grid, strips metadata, and builds a contact sheet", async () => {
    const result = await processGeneratedImage(await transparentPng(), brief({
      transparentBackground: true,
      frameColumns: 2,
      frameRows: 1,
    }));

    expect(result).toMatchObject({
      width: 32,
      height: 16,
      frameWidth: 16,
      frameHeight: 16,
      hasAlpha: true,
      transparentPixels: true,
      edits: ["metadata-stripped", "png-reencoded", "frames-cropped"],
    });
    expect(await sharp(result.bytes).metadata()).toMatchObject({ format: "png", width: 32, height: 16 });
    expect(await sharp(result.contactSheet).metadata()).toMatchObject({ width: 384, height: 192 });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.contactSheetSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("recupera sprites opacos del modelo de imagen quitando el fondo uniforme desde las esquinas", async () => {
    // Fondo magenta uniforme con un sujeto azul centrado: el modelo devuelve
    // opaco aunque se le pida transparencia; la tuberia debe recortarlo local.
    const { data, info } = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } },
    }).raw().toBuffer({ resolveWithObject: true });
    for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) {
      const offset = (y * info.width + x) * 4;
      data[offset] = 20; data[offset + 1] = 80; data[offset + 2] = 220; data[offset + 3] = 255;
    }
    const bytes = await sharp(data, { raw: info }).png().toBuffer();
    const result = await processGeneratedImage(
      { bytes, mimeType: "image/png", width: 32, height: 32, model, responseId: "resp_opaque_sprite" },
      brief({ transparentBackground: true }),
    );
    expect(result.transparentPixels).toBe(true);
    expect(result.edits).toContain("background-removed");
    const raw = await sharp(result.bytes).raw().toBuffer();
    expect(raw[3]).toBe(0);
  });

  it("rejects missing real transparency even when the request asked for alpha", async () => {
    const opaquePng = await image({ width: 16, height: 16 });
    await expect(processGeneratedImage(opaquePng, brief({ transparentBackground: true })))
      .rejects.toMatchObject({ code: "generated_image_alpha_missing" });
  });

  it("rejects corrupt bytes and MIME claims that disagree with the file signature", async () => {
    await expect(processGeneratedImage({
      bytes: Buffer.from("not an image"), mimeType: "image/png", width: 1, height: 1, model, responseId: "resp_bad",
    }, brief())).rejects.toMatchObject({ code: "generated_image_mime_mismatch" });

    const png = await image();
    await expect(processGeneratedImage({ ...png, mimeType: "image/webp" }, brief()))
      .rejects.toMatchObject({ code: "generated_image_mime_mismatch" });
  });

  it("rejects byte, pixel, and frame-grid bombs before accepting an asset", async () => {
    const valid = await image();
    await expect(processGeneratedImage({
      ...valid,
      bytes: Buffer.alloc(20 * 1024 * 1024 + 1),
    }, brief())).rejects.toMatchObject({ code: "generated_image_size_invalid" });
    await expect(processGeneratedImage({ ...valid, width: 8_192, height: 8_192 }, brief()))
      .rejects.toMatchObject({ code: "generated_image_dimensions_invalid" });

    const odd = await image({ width: 31, height: 31 });
    await expect(processGeneratedImage(odd, brief({ frameColumns: 2, frameRows: 2 })))
      .rejects.toMatchObject({ code: "generated_image_frame_grid_invalid" });
  });

  it("builds a 3 by 3 tile sheet and reports edge mismatch as a review heuristic", async () => {
    const { data, info } = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y++) {
      const lastPixel = (y * info.width + info.width - 1) * 4;
      data[lastPixel] = 0;
      data[lastPixel + 1] = 0;
      data[lastPixel + 2] = 255;
    }
    const bytes = await sharp(data, { raw: info }).png().toBuffer();
    const tile: MetaImageResult = { bytes, mimeType: "image/png", width: 8, height: 8, model, responseId: "resp_tile_fixture" };
    const result = await processGeneratedImage(tile, brief({
      assetType: "tileset",
      tileSize: 8,
      tileable: true,
    }));

    expect(await sharp(result.contactSheet).metadata()).toMatchObject({ width: 24, height: 24 });
    expect(result.tileSeams).toMatchObject({ reviewRequired: true, horizontalMeanAbsoluteError: expect.any(Number) });
  });

  it("accepts valid JPEG and WebP source signatures and deterministically re-encodes PNG", async () => {
    for (const format of ["jpeg", "webp"] as const) {
      const result = await processGeneratedImage(await image({ format, channels: 3 }), brief());
      expect(await sharp(result.bytes).metadata()).toMatchObject({ format: "png", width: 32, height: 16 });
      expect(result.edits).toContain("png-reencoded");
    }
  });
});
