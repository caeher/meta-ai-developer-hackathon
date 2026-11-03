import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import {
  GeneratedAssetMetadataSchema,
  MakeTransparentInputSchema,
  MakeTransparentResultSchema,
  type MakeTransparentResult,
} from "@meta-game/contracts";
import { OwnedResourceNotFoundError, type RunWorkerClaim, type VerifiedIdentityContext } from "@meta-game/db";
import type { StorageAsset } from "@meta-game/storage";
import {
  GENERATED_MANIFEST_PATH, MAX_PROJECT_GENERATED_ASSETS,
  RuntimeGeneratedAssetManifestSchema, RuntimeGeneratedAssetSchema, loadRuntimeManifest,
  type ImageSandbox,
} from "./image-generator";
import { applyTransparencyToPng, TransparencyError } from "./transparency";

const MAX_MANIFEST_BYTES = 256 * 1024;
export type MakeTransparentToolContext = Readonly<{ claim: RunWorkerClaim; callId: string; projectId: string; signal: AbortSignal }>;
export interface MakeTransparentStorage {
  read(identity: VerifiedIdentityContext, assetId: string): Promise<{ asset: Pick<StorageAsset, "id" | "projectId" | "contentType" | "sizeBytes" | "sha256" | "metadata">; body: Uint8Array }>;
  upload(identity: VerifiedIdentityContext, request: { projectId: string; contentType: "image/png"; body: Uint8Array; metadata: Record<string, unknown> }): Promise<Pick<StorageAsset, "id" | "sha256" | "status">>;
  delete(identity: VerifiedIdentityContext, assetId: string): Promise<void>;
}

export class MakeTransparentToolError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "MakeTransparentToolError"; }
}

/** Local, non-billable derivation: new transparent PNG from a registered private frame. Source is never modified. */
export function createMakeTransparentTool(input: {
  storage: MakeTransparentStorage; sandbox: ImageSandbox;
  identity(claim: RunWorkerClaim): Promise<VerifiedIdentityContext>; now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return async function makeTransparentTool(rawInput: Record<string, unknown>, context: MakeTransparentToolContext): Promise<MakeTransparentResult> {
    const parsed = MakeTransparentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new Error("agent_invalid_tool_arguments");
    const request = parsed.data;
    if (context.projectId !== context.claim.projectId) throw new OwnedResourceNotFoundError();
    context.signal.throwIfAborted();
    const manifest = await loadRuntimeManifest(input.sandbox, context.projectId, context.signal);
    const entry = manifest.assets.find((a) => a.assetId === request.sourceAssetId);
    if (!entry) throw new OwnedResourceNotFoundError();
    if (request.sourceFrameIndex >= entry.frameColumns * entry.frameRows) throw new MakeTransparentToolError("transparency_frame_out_of_range");
    const identity = await input.identity(context.claim);
    let stored: Awaited<ReturnType<MakeTransparentStorage["read"]>>;
    try { stored = await input.storage.read(identity, request.sourceAssetId); }
    catch (error) { if (error instanceof OwnedResourceNotFoundError) throw error; throw new MakeTransparentToolError("transparency_source_unavailable"); }
    if (stored.asset.id !== request.sourceAssetId || stored.asset.projectId !== context.projectId) throw new OwnedResourceNotFoundError();
    if (stored.asset.contentType !== "image/png" || stored.body.byteLength !== stored.asset.sizeBytes || sha256(stored.body) !== stored.asset.sha256) {
      throw new MakeTransparentToolError("transparency_source_integrity_invalid");
    }
    const sourceMeta = GeneratedAssetMetadataSchema.safeParse(stored.asset.metadata);
    if (!sourceMeta.success || sourceMeta.data.sha256 !== stored.asset.sha256) throw new MakeTransparentToolError("transparency_source_metadata_invalid");

    const left = (request.sourceFrameIndex % entry.frameColumns) * entry.frameWidth;
    const top = Math.floor(request.sourceFrameIndex / entry.frameColumns) * entry.frameHeight;
    let frameBytes: Buffer;
    try {
      frameBytes = await sharp(Buffer.from(stored.body), { failOn: "error", limitInputPixels: 40_000_000 })
        .extract({ left, top, width: entry.frameWidth, height: entry.frameHeight }).png().toBuffer();
    } catch { throw new MakeTransparentToolError("transparency_source_frame_invalid"); }

    let processed: Awaited<ReturnType<typeof applyTransparencyToPng>>;
    try { processed = await applyTransparencyToPng(frameBytes, { mode: request.mode, tolerance: request.tolerance, ...(request.color ? { color: request.color } : {}) }); }
    catch (error) { if (error instanceof TransparencyError) throw new MakeTransparentToolError(error.code); throw error; }
    const outSha = sha256(processed.bytes);

    let contactSheetBytes: Buffer;
    try {
      contactSheetBytes = await sharp({ create: { width: processed.width, height: processed.height, channels: 4, background: { r: 36, g: 40, b: 59, alpha: 1 } } })
        .composite([{ input: processed.bytes }]).png().toBuffer();
    } catch { throw new MakeTransparentToolError("transparency_contact_sheet_failed"); }
    const contactSha = sha256(contactSheetBytes);
    const createdAt = now().toISOString();
    const contact = await input.storage.upload(identity, {
      projectId: context.projectId, contentType: "image/png", body: contactSheetBytes,
      metadata: { schemaVersion: 1, assetType: "qa-contact-sheet", sourceAssetId: request.sourceAssetId, sha256: contactSha, createdAt, visualReview: "pending-in-live-preview" },
    });
    if (contact.status !== "ready" || !z.string().uuid().safeParse(contact.id).success) throw new MakeTransparentToolError("transparency_contact_sheet_storage_failed");

    let asset: Pick<StorageAsset, "id" | "sha256" | "status"> | undefined;
    try {
      const metadata = GeneratedAssetMetadataSchema.parse({
        ...sourceMeta.data,
        sha256: outSha, originalSha256: stored.asset.sha256,
        width: processed.width, height: processed.height, hasAlpha: true, transparentPixels: true, requestedTransparency: true,
        provenance: "meta-image-edit",
        derivation: { sourceAssetId: request.sourceAssetId, sourceSha256: stored.asset.sha256, sourceFrameIndex: request.sourceFrameIndex, requestedChange: `make-transparent:${request.mode}` },
        frames: { columns: 1, rows: 1, frameWidth: processed.width, frameHeight: processed.height },
        qa: { contactSheetAssetId: contact.id, contactSheetSha256: contactSha, visualReview: "pending-in-live-preview" },
      });
      asset = await input.storage.upload(identity, { projectId: context.projectId, contentType: "image/png", body: processed.bytes, metadata: metadata as unknown as Record<string, unknown> });
      if (asset.status !== "ready" || asset.id === request.sourceAssetId || asset.sha256 !== outSha || !z.string().uuid().safeParse(asset.id).success) {
        throw new MakeTransparentToolError("transparency_asset_storage_failed");
      }
      const newEntry = RuntimeGeneratedAssetSchema.parse({
        assetId: asset.id, key: `generated-${asset.id}`, path: `assets/generated/${asset.id}.png`,
        assetType: entry.assetType === "tileset" ? "sprite" : entry.assetType,
        frameColumns: 1, frameRows: 1, frameWidth: processed.width, frameHeight: processed.height,
      });
      if (manifest.assets.length >= MAX_PROJECT_GENERATED_ASSETS) throw new MakeTransparentToolError("transparency_manifest_limit");
      const updated = RuntimeGeneratedAssetManifestSchema.parse({ schemaVersion: 1, assets: [...manifest.assets, newEntry] });
      const manifestText = `${JSON.stringify(updated, null, 2)}\n`;
      if (Buffer.byteLength(manifestText, "utf8") > MAX_MANIFEST_BYTES) throw new MakeTransparentToolError("transparency_manifest_too_large");
      const written = await input.sandbox.writeBinaryFile(context.projectId, `public/${newEntry.path}`, processed.bytes, context.signal);
      if (written.bytesWritten !== processed.bytes.byteLength) throw new MakeTransparentToolError("transparency_workspace_write_failed");
      const mw = await input.sandbox.writeFile(context.projectId, GENERATED_MANIFEST_PATH, manifestText, context.signal);
      if (mw.bytesWritten !== Buffer.byteLength(manifestText, "utf8")) throw new MakeTransparentToolError("transparency_manifest_write_failed");
      return MakeTransparentResultSchema.parse({
        assetId: asset.id, sourceAssetId: request.sourceAssetId, sourceSha256: stored.asset.sha256, sha256: outSha,
        path: newEntry.path, width: processed.width, height: processed.height,
        removedPixels: processed.removedPixels, transparentPixels: true, mode: request.mode, reviewStatus: "pending-in-live-preview",
      });
    } catch (error) {
      if (asset?.status === "ready") await input.storage.delete(identity, asset.id).catch(() => undefined);
      await input.storage.delete(identity, contact.id).catch(() => undefined);
      throw error;
    }
  };
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }