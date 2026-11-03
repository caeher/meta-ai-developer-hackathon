import { z } from "zod";
import {
  GeneratedAssetMetadataSchema,
  ImageGenerationBriefSchema,
  type ImageGenerationBrief,
  type MetaImageResult,
} from "@meta-game/contracts";
import type { RunWorkerClaim, VerifiedIdentityContext } from "@meta-game/db";
import type { MetaClient, MetaImageReference } from "@meta-game/meta";
import type { SandboxControllerClient } from "@meta-game/sandbox";
import type { StorageAsset } from "@meta-game/storage";
import { sensitiveInputReason } from "../agent/safety";
import { ImagePipelineError, prepareImageReference, processGeneratedImage } from "./image-pipeline";

const ASSET_FILE_LIMIT = 8 * 1024 * 1024;
export const GENERATED_MANIFEST_PATH = "public/assets/generated/manifest.json";
export const MAX_PROJECT_GENERATED_ASSETS = 128;

export const RuntimeGeneratedAssetSchema = z.object({
  assetId: z.string().uuid(),
  key: z.string().regex(/^generated-[0-9a-f-]{36}$/),
  path: z.string().regex(/^assets\/generated\/[0-9a-f-]{36}\.png$/),
  assetType: z.enum(["sprite", "background", "tileset", "ui"]),
  frameColumns: z.number().int().min(1).max(8),
  frameRows: z.number().int().min(1).max(8),
  frameWidth: z.number().int().min(1).max(2_048),
  frameHeight: z.number().int().min(1).max(2_048),
}).strict().superRefine((asset, context) => {
  if (asset.key !== `generated-${asset.assetId}` || asset.path !== `assets/generated/${asset.assetId}.png`) {
    context.addIssue({ code: "custom", path: ["path"], message: "Generated asset path must be derived from its ID." });
  }
});

export const RuntimeGeneratedAssetManifestSchema = z.object({
  schemaVersion: z.literal(1),
  assets: z.array(RuntimeGeneratedAssetSchema).max(MAX_PROJECT_GENERATED_ASSETS),
}).strict().superRefine((manifest, context) => {
  const ids = new Set<string>();
  for (const [index, asset] of manifest.assets.entries()) {
    if (ids.has(asset.assetId)) context.addIssue({ code: "custom", path: ["assets", index, "assetId"], message: "Duplicate asset ID." });
    ids.add(asset.assetId);
  }
});

export type RuntimeGeneratedAsset = z.infer<typeof RuntimeGeneratedAssetSchema>;
export type RuntimeGeneratedAssetManifest = z.infer<typeof RuntimeGeneratedAssetManifestSchema>;

export type GeneratedImageToolContext = Readonly<{
  claim: RunWorkerClaim;
  projectId: string;
  signal: AbortSignal;
  beforeRequest(): Promise<void>;
  onResponse(image: MetaImageResult): Promise<void>;
}>;

export interface GeneratedImageStorage {
  read(identity: VerifiedIdentityContext, assetId: string): Promise<{
    asset: Pick<StorageAsset, "id" | "projectId" | "contentType" | "sizeBytes" | "sha256" | "metadata">;
    body: Uint8Array;
  }>;
  upload(identity: VerifiedIdentityContext, request: {
    projectId: string;
    contentType: "image/png";
    body: Uint8Array;
    metadata: Record<string, unknown>;
  }): Promise<Pick<StorageAsset, "id" | "sha256" | "status">>;
  delete(identity: VerifiedIdentityContext, assetId: string): Promise<void>;
}

type ImageMeta = Pick<MetaClient, "generateImage">;
export type ImageSandbox = Pick<SandboxControllerClient, "readFile" | "writeFile" | "writeBinaryFile">;
type StoredImageReference = Readonly<{ assetId: string; sha256: string; bytes: Uint8Array }>;

export function createGeneratedImageTool(input: {
  meta: ImageMeta;
  storage: GeneratedImageStorage;
  sandbox: ImageSandbox;
  identity(claim: RunWorkerClaim): Promise<VerifiedIdentityContext>;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return async function generateImageTool(rawBrief: Record<string, unknown>, context: GeneratedImageToolContext) {
    const parsed = ImageGenerationBriefSchema.safeParse(rawBrief);
    if (!parsed.success) throw new Error("agent_invalid_tool_arguments");
    const brief = parsed.data;
    if (sensitiveInputReason(buildImagePrompt(brief))) throw new Error("agent_sensitive_content_blocked");
    const manifest = await loadRuntimeManifest(input.sandbox, context.projectId, context.signal);
    const identity = await input.identity(context.claim);
    const reference = await loadLatestImageReference(input.storage, identity, context.projectId, manifest);
    const prompt = buildImagePrompt(brief, Boolean(reference));
    if (sensitiveInputReason(prompt)) throw new Error("agent_sensitive_content_blocked");

    await context.beforeRequest();
    const imageOptions: { signal: AbortSignal; referenceImage?: MetaImageReference } = { signal: context.signal };
    if (reference) imageOptions.referenceImage = { mimeType: "image/png", bytes: reference.bytes };
    const image = await input.meta.generateImage(prompt, imageOptions);
    await context.onResponse(image);

    let processed;
    try {
      processed = await processGeneratedImage(image, brief);
    } catch (error) {
      if (error instanceof ImagePipelineError) throw error;
      throw new ImagePipelineError("generated_image_pipeline_failed");
    }
    if (processed.bytes.byteLength > ASSET_FILE_LIMIT || processed.contactSheet.byteLength > ASSET_FILE_LIMIT) {
      throw new ImagePipelineError("generated_asset_size_invalid");
    }

    const generatedAt = now().toISOString();
    const contactSheet = await input.storage.upload(identity, {
      projectId: context.projectId,
      contentType: "image/png",
      body: processed.contactSheet,
      metadata: {
        schemaVersion: 1,
        source: "meta-model-api",
        assetType: "qa-contact-sheet",
        model: image.model,
        createdAt: generatedAt,
        sourceSha256: processed.sourceSha256,
        sha256: processed.contactSheetSha256,
        visualReview: "pending-in-live-preview",
      },
    });
    if (contactSheet.status !== "ready" || !z.string().uuid().safeParse(contactSheet.id).success) {
      throw new ImagePipelineError("generated_contact_sheet_storage_failed");
    }

    let primaryAsset: Pick<StorageAsset, "id" | "sha256" | "status"> | undefined;
    try {
      const metadata = GeneratedAssetMetadataSchema.parse({
        schemaVersion: 1,
        source: "meta-model-api",
        assetType: brief.assetType,
        model: image.model,
        prompt,
        createdAt: generatedAt,
        responseId: image.responseId,
        ...(image.requestId ? { requestId: image.requestId } : {}),
        originalMimeType: image.mimeType,
        mimeType: "image/png",
        originalSha256: processed.sourceSha256,
        sha256: processed.sha256,
        ...(reference ? { reference: { assetId: reference.assetId, sha256: reference.sha256 } } : {}),
        width: processed.width,
        height: processed.height,
        hasAlpha: processed.hasAlpha,
        transparentPixels: processed.transparentPixels,
        requestedTransparency: brief.transparentBackground,
        frames: {
          columns: brief.frameColumns,
          rows: brief.frameRows,
          frameWidth: processed.frameWidth,
          frameHeight: processed.frameHeight,
        },
        edits: processed.edits,
        qa: {
          contactSheetAssetId: contactSheet.id,
          contactSheetSha256: processed.contactSheetSha256,
          ...(processed.tileSeams ? { tileSeams: processed.tileSeams } : {}),
          visualReview: "pending-in-live-preview",
        },
      });
      primaryAsset = await input.storage.upload(identity, {
        projectId: context.projectId,
        contentType: "image/png",
        body: processed.bytes,
        metadata: metadata as unknown as Record<string, unknown>,
      });
      if (primaryAsset.status !== "ready" || !z.string().uuid().safeParse(primaryAsset.id).success || primaryAsset.sha256 !== processed.sha256) {
        throw new ImagePipelineError("generated_asset_storage_failed");
      }

      const assetPath = `public/assets/generated/${primaryAsset.id}.png`;
      const runtimePath = `assets/generated/${primaryAsset.id}.png`;
      const key = `generated-${primaryAsset.id}`;
      if (manifest.assets.length >= MAX_PROJECT_GENERATED_ASSETS) throw new ImagePipelineError("generated_asset_manifest_limit");
      const entry = RuntimeGeneratedAssetSchema.parse({
        assetId: primaryAsset.id,
        key,
        path: runtimePath,
        assetType: brief.assetType,
        frameColumns: brief.frameColumns,
        frameRows: brief.frameRows,
        frameWidth: processed.frameWidth,
        frameHeight: processed.frameHeight,
      });
      const nextManifest = RuntimeGeneratedAssetManifestSchema.parse({
        schemaVersion: 1,
        assets: [...manifest.assets, entry],
      });
      const manifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;
      if (Buffer.byteLength(manifestText, "utf8") > 256 * 1024) throw new ImagePipelineError("generated_asset_manifest_too_large");

      const written = await input.sandbox.writeBinaryFile(context.projectId, assetPath, processed.bytes, context.signal);
      if (written.bytesWritten !== processed.bytes.byteLength) throw new ImagePipelineError("generated_asset_workspace_write_failed");
      const manifestWrite = await input.sandbox.writeFile(context.projectId, GENERATED_MANIFEST_PATH, manifestText, context.signal);
      if (manifestWrite.bytesWritten !== Buffer.byteLength(manifestText, "utf8")) {
        throw new ImagePipelineError("generated_asset_manifest_write_failed");
      }
      return {
        assetId: primaryAsset.id,
        contactSheetAssetId: contactSheet.id,
        assetType: brief.assetType,
        path: assetPath.slice("public/".length),
        manifestPath: GENERATED_MANIFEST_PATH,
        bytesWritten: written.bytesWritten,
        sha256: processed.sha256,
        mimeType: "image/png",
        width: processed.width,
        height: processed.height,
        phaserKey: key,
        frameCount: brief.frameColumns * brief.frameRows,
        frameWidth: processed.frameWidth,
        frameHeight: processed.frameHeight,
        alphaVerified: brief.transparentBackground ? processed.hasAlpha && processed.transparentPixels : processed.hasAlpha,
        qa: {
          contactSheetAssetId: contactSheet.id,
          ...(processed.tileSeams ? { tileSeams: processed.tileSeams } : {}),
          visualReview: "pending-in-live-preview" as const,
        },
      };
    } catch (error) {
      if (primaryAsset?.status === "ready") await input.storage.delete(identity, primaryAsset.id).catch(() => undefined);
      await input.storage.delete(identity, contactSheet.id).catch(() => undefined);
      throw error;
    }
  };
}

export function buildImagePrompt(brief: ImageGenerationBrief, hasStyleReference = false): string {
  const palette = brief.palette.length ? brief.palette.join(", ") : "a restrained palette suited to the described game";
  const frameCount = brief.frameColumns * brief.frameRows;
  const layout = frameCount > 1
    ? `Use an exact ${brief.frameColumns} column by ${brief.frameRows} row grid with ${frameCount} equal cells, consistent character scale, no gutters, and one complete animation frame centered in every cell.`
    : "Create one complete asset with a clean silhouette and no surrounding contact sheet.";
  const tile = brief.assetType === "tileset"
    ? `Each cell is exactly ${brief.tileSize} by ${brief.tileSize} logical pixels. ${brief.tileable ? "The first tile must repeat seamlessly on all four edges." : "Keep all tiles aligned to the same grid."}`
    : "";
  const alpha = brief.transparentBackground
    ? "Use true transparent pixels outside the artwork, with no matte, shadow canvas, checkerboard, or colored background."
    : "Use a complete opaque background appropriate for the asset.";
  return [
    "Create one original 2D video game asset for a Phaser 3.90 game.",
    `Asset type: ${brief.assetType}. Camera/view: ${brief.view}. Art style: ${brief.style}.`,
    `Description: ${brief.description}`,
    ...(hasStyleReference ? ["Use the supplied same-project reference image only to match its visual style, palette, line weight, lighting, and relative scale. Preserve the new asset description and requested view; do not copy the reference subject unless the description asks for it."] : []),
    `Palette: ${palette}. ${alpha}`,
    layout,
    tile,
    "Do not include text, logos, watermarks, UI labels, borders, or unrelated objects. Keep shapes crisp and readable at game scale.",
  ].filter(Boolean).join("\n");
}

async function loadLatestImageReference(
  storage: GeneratedImageStorage,
  identity: VerifiedIdentityContext,
  projectId: string,
  manifest: z.infer<typeof RuntimeGeneratedAssetManifestSchema>,
): Promise<StoredImageReference | undefined> {
  const entry = manifest.assets.at(-1);
  if (!entry) return undefined;
  let stored: Awaited<ReturnType<GeneratedImageStorage["read"]>>;
  try {
    stored = await storage.read(identity, entry.assetId);
  } catch {
    throw new ImagePipelineError("generated_reference_asset_unavailable");
  }
  const metadata = GeneratedAssetMetadataSchema.safeParse(stored.asset.metadata);
  if (stored.asset.id !== entry.assetId || stored.asset.projectId !== projectId || stored.asset.contentType !== "image/png" ||
      stored.asset.sizeBytes < 1 || stored.asset.sizeBytes > ASSET_FILE_LIMIT || stored.asset.sha256.length !== 64 ||
      stored.body.byteLength !== stored.asset.sizeBytes ||
      !metadata.success || metadata.data.assetType !== entry.assetType || metadata.data.sha256 !== stored.asset.sha256 ||
      metadata.data.width !== entry.frameWidth * entry.frameColumns || metadata.data.height !== entry.frameHeight * entry.frameRows ||
      metadata.data.frames.columns !== entry.frameColumns || metadata.data.frames.rows !== entry.frameRows ||
      metadata.data.frames.frameWidth !== entry.frameWidth || metadata.data.frames.frameHeight !== entry.frameHeight) {
    throw new ImagePipelineError("generated_reference_asset_invalid");
  }
  const bytes = await prepareImageReference(stored.body);
  return { assetId: entry.assetId, sha256: stored.asset.sha256, bytes };
}

export async function loadRuntimeManifest(
  sandbox: ImageSandbox,
  projectId: string,
  signal: AbortSignal,
): Promise<z.infer<typeof RuntimeGeneratedAssetManifestSchema>> {
  let stored: { content: string };
  try {
    stored = await sandbox.readFile(projectId, GENERATED_MANIFEST_PATH, signal);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as Error & { code?: unknown }).code : undefined;
    if (code === "file_not_found" || code === "path_not_found" || code === "not_found" || code === "sandbox_not_found") {
      return { schemaVersion: 1, assets: [] };
    }
    throw new ImagePipelineError("generated_asset_manifest_read_failed");
  }
  if (Buffer.byteLength(stored.content, "utf8") > 256 * 1024) throw new ImagePipelineError("generated_asset_manifest_too_large");
  try {
    return RuntimeGeneratedAssetManifestSchema.parse(JSON.parse(stored.content) as unknown);
  } catch {
    throw new ImagePipelineError("generated_asset_manifest_invalid");
  }
}

export function imageResponseTokenUsage(image: MetaImageResult): number {
  const total = image.usage?.totalTokens ?? 0;
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
}
