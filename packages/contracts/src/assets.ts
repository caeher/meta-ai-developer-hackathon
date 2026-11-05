import { z } from "zod";
import { SANDBOX_BINARY_FILE_MAX_BYTES } from "./tools";

export const ImageGenerationBriefSchema = z.object({
  assetType: z.enum(["sprite", "background", "tileset", "ui"]),
  description: z.string().trim().min(8).max(1_000),
  style: z.string().trim().min(2).max(160),
  view: z.enum(["side", "front", "top-down", "isometric", "orthographic"]),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(8).default([]),
  transparentBackground: z.boolean().default(false),
  frameColumns: z.number().int().min(1).max(8).default(1),
  frameRows: z.number().int().min(1).max(8).default(1),
  tileSize: z.number().int().min(8).max(256).optional(),
  tileable: z.boolean().default(false),
}).strict().superRefine((brief, context) => {
  const frameCount = brief.frameColumns * brief.frameRows;
  if (frameCount > 1 && !["sprite", "tileset"].includes(brief.assetType)) {
    context.addIssue({ code: "custom", path: ["frameColumns"], message: "Only sprites and tilesets may contain multiple frames." });
  }
  if (brief.assetType === "tileset" && brief.tileSize === undefined) {
    context.addIssue({ code: "custom", path: ["tileSize"], message: "Tilesets require a fixed tile size." });
  }
  if (brief.assetType !== "tileset" && (brief.tileSize !== undefined || brief.tileable)) {
    context.addIssue({ code: "custom", path: ["tileSize"], message: "Tile options are only valid for tilesets." });
  }
});

export const GeneratedAssetMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("meta-model-api"),
  assetType: z.enum(["sprite", "background", "tileset", "ui", "qa-contact-sheet"]),
  model: z.string().min(1).max(128),
  prompt: z.string().min(1).max(16_384),
  createdAt: z.string().datetime(),
  responseId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128).optional(),
  originalMimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  mimeType: z.literal("image/png"),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reference: z.object({
    assetId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  provenance: z.literal("meta-image-edit").optional(),
  derivation: z.object({
    sourceAssetId: z.string().uuid(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceFrameIndex: z.number().int().min(0).max(63),
    requestedChange: z.string().min(8).max(800),
  }).strict().optional(),
  width: z.number().int().min(1).max(2_048),
  height: z.number().int().min(1).max(2_048),
  hasAlpha: z.boolean(),
  transparentPixels: z.boolean(),
  requestedTransparency: z.boolean(),
  frames: z.object({
    columns: z.number().int().min(1).max(8),
    rows: z.number().int().min(1).max(8),
    frameWidth: z.number().int().min(1).max(2_048),
    frameHeight: z.number().int().min(1).max(2_048),
  }).strict(),
  edits: z.array(z.enum(["orientation-normalized", "metadata-stripped", "png-reencoded", "bounded-resize", "frames-cropped", "background-removed"])).max(8),
  qa: z.object({
    contactSheetAssetId: z.string().uuid(),
    contactSheetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    tileSeams: z.object({
      horizontalMeanAbsoluteError: z.number().min(0).max(255).optional(),
      verticalMeanAbsoluteError: z.number().min(0).max(255).optional(),
      reviewRequired: z.boolean(),
    }).strict().optional(),
    visualReview: z.literal("pending-in-live-preview"),
  }).strict(),
}).strict();

export type ImageGenerationBrief = z.infer<typeof ImageGenerationBriefSchema>;
export type GeneratedAssetMetadata = z.infer<typeof GeneratedAssetMetadataSchema>;

export const GeneratedImageToolResultSchema = z.object({
  assetId: z.string().uuid(),
  contactSheetAssetId: z.string().uuid(),
  assetType: z.enum(["sprite", "background", "tileset", "ui"]),
  path: z.string().regex(/^assets\/generated\/[0-9a-f-]{36}\.png$/),
  manifestPath: z.literal("public/assets/generated/manifest.json"),
  bytesWritten: z.number().int().positive().max(SANDBOX_BINARY_FILE_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.literal("image/png"),
  width: z.number().int().min(1).max(2_048),
  height: z.number().int().min(1).max(2_048),
  phaserKey: z.string().regex(/^generated-[0-9a-f-]{36}$/),
  frameCount: z.number().int().min(1).max(64),
  frameWidth: z.number().int().min(1).max(2_048),
  frameHeight: z.number().int().min(1).max(2_048),
  alphaVerified: z.boolean(),
  qa: z.object({
    contactSheetAssetId: z.string().uuid(),
    tileSeams: z.object({
      horizontalMeanAbsoluteError: z.number().min(0).max(255).optional(),
      verticalMeanAbsoluteError: z.number().min(0).max(255).optional(),
      reviewRequired: z.boolean(),
    }).strict().optional(),
    visualReview: z.literal("pending-in-live-preview"),
  }).strict(),
}).strict().superRefine((result, context) => {
  if (result.path !== `assets/generated/${result.assetId}.png` || result.phaserKey !== `generated-${result.assetId}` ||
      result.qa.contactSheetAssetId !== result.contactSheetAssetId || result.width % result.frameWidth !== 0 ||
      result.height % result.frameHeight !== 0 || (result.width / result.frameWidth) * (result.height / result.frameHeight) !== result.frameCount) {
    context.addIssue({ code: "custom", path: ["assetId"], message: "Generated image result must have consistent ID-derived paths and frame metadata." });
  }
});

export type GeneratedImageToolResult = z.infer<typeof GeneratedImageToolResultSchema>;

export const META_IMAGE_MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const GENERATED_ASSET_MAX_BYTES = 8 * 1024 * 1024;
export const GENERATED_ASSET_MAX_DIMENSION = 2_048;
export const GENERATED_ASSET_MAX_PIXELS = 40_000_000;
const MAX_BINARY_FILE_BASE64_CHARS = Math.ceil(SANDBOX_BINARY_FILE_MAX_BYTES / 3) * 4;

export const SandboxWriteBinaryFileInputSchema = z.object({
  path: z.string().min(1).max(512).refine((value) => {
    if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
    return value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." &&
      ![...part].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
  }, "Path must stay within the workspace"),
  contentBase64: z.string().min(4).max(MAX_BINARY_FILE_BASE64_CHARS)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict().superRefine((input, context) => {
  const padding = input.contentBase64.endsWith("==") ? 2 : input.contentBase64.endsWith("=") ? 1 : 0;
  const decodedBytes = input.contentBase64.length / 4 * 3 - padding;
  if (decodedBytes < 1 || decodedBytes > SANDBOX_BINARY_FILE_MAX_BYTES) {
    context.addIssue({ code: "custom", path: ["contentBase64"], message: "Binary asset exceeds the file size limit." });
  }
  if (!/^public\/assets\/generated\/(?:[a-z0-9-]+|(?:atlases|tilesets)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.png$/.test(input.path)) {
    context.addIssue({ code: "custom", path: ["path"], message: "Binary writes are restricted to generated PNG assets." });
  }
});

export type SandboxWriteBinaryFileInput = z.infer<typeof SandboxWriteBinaryFileInputSchema>;
