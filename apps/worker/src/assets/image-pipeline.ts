import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  GENERATED_ASSET_MAX_BYTES,
  GENERATED_ASSET_MAX_DIMENSION,
  GENERATED_ASSET_MAX_PIXELS,
  META_IMAGE_MAX_SOURCE_BYTES,
  type ImageGenerationBrief,
  type MetaImageResult,
} from "@meta-game/contracts";

const CONTACT_CELL_SIZE = 192;
const MAX_TILE_SEAM_ERROR = 24;
export const MAX_META_IMAGE_REFERENCE_BYTES = 512 * 1024;

export class ImagePipelineError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ImagePipelineError";
  }
}

export async function prepareImageReference(bytes: Uint8Array): Promise<Buffer> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024 ||
      bytes.byteLength < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    throw new ImagePipelineError("generated_reference_image_invalid");
  }
  const source = Buffer.from(bytes);
  let metadata;
  try {
    metadata = await sharp(source, { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS }).metadata();
  } catch {
    throw new ImagePipelineError("generated_reference_image_invalid");
  }
  if (metadata.format !== "png" || !metadata.width || !metadata.height || metadata.width > GENERATED_ASSET_MAX_DIMENSION ||
      metadata.height > GENERATED_ASSET_MAX_DIMENSION || metadata.width * metadata.height > GENERATED_ASSET_MAX_PIXELS) {
    throw new ImagePipelineError("generated_reference_image_invalid");
  }
  if (source.byteLength <= MAX_META_IMAGE_REFERENCE_BYTES) return source;

  for (const size of [512, 384, 256, 192, 128, 96, 64]) {
    const compact = await sharp(source, { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS })
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer()
      .catch(() => { throw new ImagePipelineError("generated_reference_image_invalid"); });
    if (compact.byteLength <= MAX_META_IMAGE_REFERENCE_BYTES) return compact;
  }
  throw new ImagePipelineError("generated_reference_image_too_large");
}

export type ProcessedGeneratedImage = Readonly<{
  bytes: Buffer;
  width: number;
  height: number;
  hasAlpha: boolean;
  transparentPixels: boolean;
  frameWidth: number;
  frameHeight: number;
  sourceSha256: string;
  sha256: string;
  edits: Array<"orientation-normalized" | "metadata-stripped" | "png-reencoded" | "bounded-resize" | "frames-cropped">;
  contactSheet: Buffer;
  contactSheetSha256: string;
  tileSeams?: {
    horizontalMeanAbsoluteError: number;
    verticalMeanAbsoluteError: number;
    reviewRequired: boolean;
  };
}>;

const mimeFormat: Record<MetaImageResult["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

export async function processGeneratedImage(
  image: MetaImageResult,
  brief: ImageGenerationBrief,
): Promise<ProcessedGeneratedImage> {
  if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength < 1 || image.bytes.byteLength > META_IMAGE_MAX_SOURCE_BYTES) {
    throw new ImagePipelineError("generated_image_size_invalid");
  }
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 ||
      image.width > 8_192 || image.height > 8_192 || image.width * image.height > GENERATED_ASSET_MAX_PIXELS) {
    throw new ImagePipelineError("generated_image_dimensions_invalid");
  }
  const source = Buffer.from(image.bytes);
  if (detectMime(source) !== image.mimeType) throw new ImagePipelineError("generated_image_mime_mismatch");

  const decoder = sharp(source, { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS, sequentialRead: true });
  let metadata;
  let alphaBytes: Buffer | undefined;
  try {
    metadata = await decoder.metadata();
    if (metadata.hasAlpha) {
      alphaBytes = await sharp(source, { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS })
        .ensureAlpha().extractChannel(3).raw().toBuffer();
    }
  } catch {
    throw new ImagePipelineError("generated_image_decode_failed");
  }
  if (metadata.format !== mimeFormat[image.mimeType] || metadata.width !== image.width || metadata.height !== image.height ||
      !metadata.width || !metadata.height || metadata.width * metadata.height > GENERATED_ASSET_MAX_PIXELS) {
    throw new ImagePipelineError("generated_image_metadata_mismatch");
  }
  const hasAlpha = metadata.hasAlpha === true;
  const transparentPixels = hasAlpha && Boolean(alphaBytes?.some((alpha) => alpha < 255));
  if (brief.transparentBackground && (!hasAlpha || !transparentPixels)) {
    throw new ImagePipelineError("generated_image_alpha_missing");
  }

  const columns = brief.frameColumns;
  const rows = brief.frameRows;
  const frameCount = columns * rows;
  let transform = sharp(source, { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS, sequentialRead: true }).rotate();
  if (brief.assetType === "tileset" && brief.tileSize) {
    transform = transform.resize({
      width: columns * brief.tileSize,
      height: rows * brief.tileSize,
      fit: "fill",
      kernel: sharp.kernel.nearest,
    });
  } else {
    transform = transform.resize({
      width: GENERATED_ASSET_MAX_DIMENSION,
      height: GENERATED_ASSET_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
      kernel: sharp.kernel.nearest,
    });
  }

  const normalized = await transform.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer({ resolveWithObject: true })
    .catch(() => { throw new ImagePipelineError("generated_image_normalization_failed"); });
  const { data: bytes, info } = normalized;
  if (bytes.byteLength < 1 || bytes.byteLength > GENERATED_ASSET_MAX_BYTES || info.width < 1 || info.height < 1 ||
      info.width > GENERATED_ASSET_MAX_DIMENSION || info.height > GENERATED_ASSET_MAX_DIMENSION ||
      info.width * info.height > GENERATED_ASSET_MAX_PIXELS || info.width % columns !== 0 || info.height % rows !== 0) {
    throw new ImagePipelineError("generated_image_frame_grid_invalid");
  }
  if (brief.assetType === "tileset" && brief.tileSize && (info.width !== columns * brief.tileSize || info.height !== rows * brief.tileSize)) {
    throw new ImagePipelineError("generated_tileset_dimensions_invalid");
  }

  const frameWidth = info.width / columns;
  const frameHeight = info.height / rows;
  const imageFrames = await createContactFrames(bytes, columns, rows, frameWidth, frameHeight);
  const firstTileFrame = brief.assetType === "tileset" && brief.tileable && brief.tileSize
    ? await sharp(bytes).extract({ left: 0, top: 0, width: frameWidth, height: frameHeight }).png().toBuffer()
    : undefined;
  const tileSeams = brief.assetType === "tileset" && brief.tileable && brief.tileSize
    ? await measureTileSeams(firstTileFrame!)
    : undefined;
  const contactSheet = brief.assetType === "tileset" && brief.tileable && brief.tileSize
    ? await createRepeatedTileContactSheet(firstTileFrame!)
    : await createFrameContactSheet(imageFrames, columns, rows);

  const edits: ProcessedGeneratedImage["edits"] = ["metadata-stripped", "png-reencoded"];
  if (metadata.orientation && metadata.orientation !== 1) edits.unshift("orientation-normalized");
  const swapsDimensions = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  const displayWidth = swapsDimensions ? metadata.height : metadata.width;
  const displayHeight = swapsDimensions ? metadata.width : metadata.height;
  if (info.width !== displayWidth || info.height !== displayHeight) edits.push("bounded-resize");
  if (frameCount > 1) edits.push("frames-cropped");

  return {
    bytes,
    width: info.width,
    height: info.height,
    hasAlpha: info.channels === 4,
    transparentPixels,
    frameWidth,
    frameHeight,
    sourceSha256: sha256(source),
    sha256: sha256(bytes),
    edits,
    contactSheet,
    contactSheetSha256: sha256(contactSheet),
    ...(tileSeams ? { tileSeams } : {}),
  };
}

function detectMime(bytes: Uint8Array): MetaImageResult["mimeType"] | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

async function createContactFrames(bytes: Buffer, columns: number, rows: number, frameWidth: number, frameHeight: number): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const left = column * frameWidth;
      const top = row * frameHeight;
      try {
        frames.push(await sharp(bytes).extract({ left, top, width: frameWidth, height: frameHeight })
          .resize({ width: CONTACT_CELL_SIZE, height: CONTACT_CELL_SIZE, fit: "contain", background: { r: 36, g: 40, b: 59, alpha: 0 } })
          .png({ compressionLevel: 9 }).toBuffer());
      } catch {
        throw new ImagePipelineError("generated_image_frame_crop_failed");
      }
    }
  }
  return frames;
}

async function createFrameContactSheet(frames: readonly Buffer[], columns: number, rows: number): Promise<Buffer> {
  const layers = frames.map((input, index) => ({
    input,
    left: (index % columns) * CONTACT_CELL_SIZE,
    top: Math.floor(index / columns) * CONTACT_CELL_SIZE,
  }));
  try {
    return await sharp({
      create: {
        width: columns * CONTACT_CELL_SIZE,
        height: rows * CONTACT_CELL_SIZE,
        channels: 4,
        background: { r: 36, g: 40, b: 59, alpha: 1 },
      },
    }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    throw new ImagePipelineError("generated_image_contact_sheet_failed");
  }
}

async function measureTileSeams(tile: Buffer): Promise<NonNullable<ProcessedGeneratedImage["tileSeams"]>> {
  const { data, info } = await sharp(tile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let horizontalTotal = 0;
  let verticalTotal = 0;
  let horizontalSamples = 0;
  let verticalSamples = 0;
  for (let y = 0; y < info.height; y++) {
    const leftOffset = y * info.width * 4;
    const rightOffset = leftOffset + (info.width - 1) * 4;
    for (let channel = 0; channel < 4; channel++) {
      horizontalTotal += Math.abs(data[leftOffset + channel]! - data[rightOffset + channel]!);
      horizontalSamples++;
    }
  }
  for (let x = 0; x < info.width; x++) {
    const topOffset = x * 4;
    const bottomOffset = (info.height - 1) * info.width * 4 + x * 4;
    for (let channel = 0; channel < 4; channel++) {
      verticalTotal += Math.abs(data[topOffset + channel]! - data[bottomOffset + channel]!);
      verticalSamples++;
    }
  }
  const horizontalMeanAbsoluteError = roundMetric(horizontalTotal / horizontalSamples);
  const verticalMeanAbsoluteError = roundMetric(verticalTotal / verticalSamples);
  return {
    horizontalMeanAbsoluteError,
    verticalMeanAbsoluteError,
    reviewRequired: horizontalMeanAbsoluteError > MAX_TILE_SEAM_ERROR || verticalMeanAbsoluteError > MAX_TILE_SEAM_ERROR,
  };
}

async function createRepeatedTileContactSheet(tile: Buffer): Promise<Buffer> {
  const { width, height } = await sharp(tile).metadata();
  if (!width || !height) throw new ImagePipelineError("generated_image_contact_sheet_failed");
  const layers = Array.from({ length: 9 }, (_unused, index) => ({
    input: tile,
    left: (index % 3) * width,
    top: Math.floor(index / 3) * height,
  }));
  try {
    return await sharp({
      create: { width: width * 3, height: height * 3, channels: 4, background: { r: 36, g: 40, b: 59, alpha: 1 } },
    }).composite(layers).png({ compressionLevel: 9 }).toBuffer();
  } catch {
    throw new ImagePipelineError("generated_image_contact_sheet_failed");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}
