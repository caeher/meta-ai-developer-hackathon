import sharp from "sharp";
import { GENERATED_ASSET_MAX_PIXELS } from "@meta-game/contracts";

export class TransparencyError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "TransparencyError"; }
}

export type TransparencyOptions = Readonly<{
  mode: "corner-flood" | "color-key" | "alpha-cleanup";
  tolerance?: number;
  color?: string;
}>;

export type TransparencyResult = Readonly<{
  bytes: Buffer; width: number; height: number;
  removedPixels: number; transparentPixels: true;
}>;

function parseHex(color: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!m) throw new TransparencyError("transparency_color_invalid");
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function distance(data: Buffer, offset: number, ref: readonly [number, number, number]): number {
  const dr = data[offset]! - ref[0], dg = data[offset + 1]! - ref[1], db = data[offset + 2]! - ref[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Deterministic, local background removal. No provider call, no billing.
 * corner-flood: flood-fill from the borders against the corner colour.
 * color-key: remove every pixel close to `color`. alpha-cleanup: snap semi alpha to 0/255.
 */
export async function applyTransparencyToPng(bytes: Uint8Array, options: TransparencyOptions): Promise<TransparencyResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 8 * 1024 * 1024) throw new TransparencyError("transparency_input_invalid");
  let raw: Buffer; let width = 0; let height = 0;
  try {
    const decoded = await sharp(Buffer.from(bytes), { failOn: "error", limitInputPixels: GENERATED_ASSET_MAX_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    raw = decoded.data; width = decoded.info.width; height = decoded.info.height;
  } catch { throw new TransparencyError("transparency_input_invalid"); }
  const tolerance = Math.max(0, Math.min(100, options.tolerance ?? 16));
  const threshold = (tolerance / 100) * 441.7;
  const total = width * height;
  const remove = new Uint8Array(total);
  let removedPixels = 0;
  const mark = (index: number) => { if (!remove[index]) { remove[index] = 1; removedPixels++; } };

  if (options.mode === "alpha-cleanup") {
    for (let i = 0; i < total; i++) {
      const a = raw[i * 4 + 3]!;
      if (a > 0 && a < 128) { raw[i * 4 + 3] = 0; mark(i); } else if (a >= 128 && a < 255) raw[i * 4 + 3] = 255;
    }
  } else if (options.mode === "color-key") {
    if (!options.color) throw new TransparencyError("transparency_color_required");
    const ref = parseHex(options.color);
    for (let i = 0; i < total; i++) if (raw[i * 4 + 3]! > 0 && distance(raw, i * 4, ref) <= threshold) mark(i);
  } else {
    const ref: [number, number, number] = [raw[0]!, raw[1]!, raw[2]!];
    const queue: number[] = [];
    const seed = (index: number) => {
      if (!remove[index] && raw[index * 4 + 3]! > 0 && distance(raw, index * 4, ref) <= threshold) { mark(index); queue.push(index); }
    };
    for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
    while (queue.length) {
      const index = queue.pop()!;
      const x = index % width, y = Math.floor(index / width);
      const neighbours = [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1];
      for (const n of neighbours) if (n >= 0) seed(n);
    }
  }
  if (removedPixels === 0 && options.mode !== "alpha-cleanup") throw new TransparencyError("transparency_no_background_removed");
  for (let i = 0; i < total; i++) if (remove[i]) raw[i * 4 + 3] = 0;
  let out: Buffer;
  try {
    out = await sharp(raw, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  } catch { throw new TransparencyError("transparency_encode_failed"); }
  return { bytes: out, width, height, removedPixels, transparentPixels: true };
}