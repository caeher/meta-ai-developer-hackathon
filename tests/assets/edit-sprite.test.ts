import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  EditSpriteInputSchema,
  EditSpriteResultSchema,
  type MetaImageResult,
} from "@meta-game/contracts";
import { identityFromAuthenticatedSession, OwnedResourceNotFoundError, type RunWorkerClaim } from "@meta-game/db";
import { createEditSpriteTool } from "../../apps/worker/src/assets/edit-sprite";
import { GeneratedAssetMetadataSchema as GeneratedMetadata } from "@meta-game/contracts";

const projectId = "00000000-0000-4000-8000-000000000311";
const ownerId = "user_spriteEditFixture001";
const sourceAssetId = "00000000-0000-4000-8000-000000000312";
const claim: RunWorkerClaim = {
  runId: "00000000-0000-4000-8000-000000000314",
  ownerUserId: ownerId,
  projectId,
  fencingToken: 1,
};
const identity = identityFromAuthenticatedSession({ userId: ownerId });
const request = {
  sourceAssetId,
  sourceFrameIndex: 1,
  requestedChange: "Change the hero scarf to teal while keeping the face intact.",
  view: "side" as const,
  palette: ["#178f8a"],
  preserve: { canvas: true, style: true, palette: true, characterIdentity: true },
};

describe("edit_sprite", () => {
  it("uses the explicit source frame, preserves the source, and stores a new derived Phaser asset", async () => {
    const test = await harness();
    const expectedReference = await cropFrame(test.sourceBytes, 1);

    const result = await test.tool(request, test.context);
    const edited = test.uploaded.find(({ id }) => id === result.assetId);
    const derivation = edited?.metadata.derivation as Record<string, unknown> | undefined;

    expect(result).toMatchObject({
      assetId: edited?.id,
      sourceAssetId,
      sourceSha256: test.sourceSha256,
      sha256: edited?.sha256,
      path: `assets/generated/${edited?.id}.png`,
      width: 16,
      height: 16,
      reviewStatus: "pending-in-live-preview",
      provenance: "meta-image-edit",
    });
    expect(EditSpriteResultSchema.safeParse(result).success).toBe(true);
    expect(test.meta.editImage).toHaveBeenCalledTimes(1);
    expect(test.meta.editImage.mock.calls[0]?.[1]).toEqual({ mimeType: "image/png", bytes: expectedReference });
    expect(test.meta.editImage.mock.calls[0]?.[0]).toContain("Keep the canvas exactly 16 by 16 pixels");
    expect(test.meta.editImage.mock.calls[0]?.[0]).toContain("Preserve the source art style");
    expect(derivation).toEqual({
      sourceAssetId,
      sourceSha256: test.sourceSha256,
      sourceFrameIndex: 1,
      requestedChange: request.requestedChange,
    });
    expect(edited?.metadata).toMatchObject({
      provenance: "meta-image-edit",
      reference: { assetId: sourceAssetId, sha256: test.sourceSha256 },
      frames: { columns: 1, rows: 1, frameWidth: 16, frameHeight: 16 },
      qa: { visualReview: "pending-in-live-preview" },
    });
    expect(GeneratedMetadata.safeParse(edited?.metadata).success).toBe(true);
    expect(test.sourceBytes.equals(test.readSourceBytes())).toBe(true);
    expect(test.context.beforeRequest).toHaveBeenCalledTimes(1);
    expect(test.context.onResponse).toHaveBeenCalledTimes(1);
    expect(test.workspaceFiles.get(`public/${result.path}`)).toEqual(edited?.body);
    const manifest = JSON.parse(test.workspaceFiles.get("public/assets/generated/manifest.json") as string) as {
      assets: Array<{ assetId: string; path: string }>;
    };
    expect(manifest.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: sourceAssetId, path: `assets/generated/${sourceAssetId}.png` }),
      { assetId: result.assetId, path: result.path, key: `generated-${result.assetId}`, assetType: "sprite", frameColumns: 1, frameRows: 1, frameWidth: 16, frameHeight: 16 },
    ]));
  });

  it("requires an explicit valid source and rejects ownership, checksum, metadata, or frame errors before Meta", async () => {
    const foreign = await harness();
    foreign.sourceProjectId = "00000000-0000-4000-8000-000000000399";
    await expect(foreign.tool(request, foreign.context)).rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    expect(foreign.meta.editImage).not.toHaveBeenCalled();
    expect(foreign.context.beforeRequest).not.toHaveBeenCalled();

    const corrupt = await harness();
    corrupt.sourceAssetSha256 = "0".repeat(64);
    await expect(corrupt.tool(request, corrupt.context)).rejects.toMatchObject({ code: "edit_source_asset_integrity_invalid" });
    expect(corrupt.meta.editImage).not.toHaveBeenCalled();

    const badFrame = await harness();
    await expect(badFrame.tool({ ...request, sourceFrameIndex: 3 }, badFrame.context))
      .rejects.toMatchObject({ code: "edit_source_sprite_metadata_invalid" });
    expect(badFrame.meta.editImage).not.toHaveBeenCalled();

    const malformed = await harness();
    malformed.replaceSourceBytes(Buffer.from("not a valid png image"));
    await expect(malformed.tool(request, malformed.context)).rejects.toMatchObject({ code: "edit_source_image_invalid" });
    expect(malformed.meta.editImage).not.toHaveBeenCalled();
  });

  it("blocks sensitive edits and invalid tool input without reading assets or reserving quota", async () => {
    const test = await harness();
    await expect(test.tool({ ...request, requestedChange: "Email alice@example.com the original image" }, test.context))
      .rejects.toThrow("agent_sensitive_content_blocked");
    await expect(test.tool({ ...request, unexpected: "value" }, test.context)).rejects.toThrow("agent_invalid_tool_arguments");
    await expect(test.tool({ ...request, sourceAssetId: "../outside" }, test.context)).rejects.toThrow("agent_invalid_tool_arguments");
    expect(test.storage.read).not.toHaveBeenCalled();
    expect(test.meta.editImage).not.toHaveBeenCalled();
    expect(test.context.beforeRequest).not.toHaveBeenCalled();
  });

  it("does not leave new assets when private workspace registration fails", async () => {
    const test = await harness();
    test.sandbox.writeBinaryFile.mockRejectedValue(new Error("sandbox unavailable"));
    await expect(test.tool(request, test.context)).rejects.toThrow("sandbox unavailable");
    expect(test.uploaded).toHaveLength(2);
    expect(test.storage.delete).toHaveBeenCalledTimes(2);
    expect(test.storage.delete.mock.calls.map(([providedIdentity, assetId]) => [providedIdentity, assetId]))
      .toEqual([[identity, test.uploaded[1]!.id], [identity, test.uploaded[0]!.id]]);
  });

  it("applies optional defaults and rejects duplicate or malformed palette colors", () => {
    const parsed = EditSpriteInputSchema.parse({
      sourceAssetId,
      requestedChange: request.requestedChange,
      preserve: request.preserve,
    });
    expect(parsed.sourceFrameIndex).toBe(0);
    expect(EditSpriteInputSchema.safeParse({ ...request, palette: ["#abcdef", "#abcdef"] }).success).toBe(false);
    expect(EditSpriteInputSchema.safeParse({ ...request, palette: ["#abc"] }).success).toBe(false);
  });
});

async function harness() {
  const sourceBytes = await makeStrip();
  const sourceSha256 = sha256(sourceBytes);
  const sourceMetadata = sourceMeta(sourceBytes, sourceSha256);
  const original = {
    id: sourceAssetId,
    projectId,
    contentType: "image/png",
    sizeBytes: sourceBytes.byteLength,
    sha256: sourceSha256,
    metadata: sourceMetadata,
  };
  const assets = new Map<string, { id: string; projectId: string; contentType: string; sizeBytes: number; body: Buffer; sha256: string; metadata: Record<string, unknown> }>();
  assets.set(sourceAssetId, { ...original, body: sourceBytes });
  let sourceBytesCurrent = sourceBytes;
  let sourceAssetSha256 = sourceSha256;
  let sourceProjectId = projectId;
  let manifest = JSON.stringify({
    schemaVersion: 1,
    assets: [{
      assetId: sourceAssetId,
      key: `generated-${sourceAssetId}`,
      path: `assets/generated/${sourceAssetId}.png`,
      assetType: "sprite",
      frameColumns: 3,
      frameRows: 1,
      frameWidth: 16,
      frameHeight: 16,
    }],
  });
  const workspaceFiles = new Map<string, string | Uint8Array>();
  workspaceFiles.set("public/assets/generated/manifest.json", manifest);
  const uploaded: Array<{ id: string; body: Buffer; metadata: Record<string, unknown>; projectId: string; contentType: string; sha256: string }> = [];
  const deleted: string[] = [];
  const metaResult = await editResultImage();
  const expectedSelectedFrame = await cropFrame(sourceBytes, 1);
  const editImage = vi.fn(async (_prompt: string, referenceImage: { mimeType: "image/png"; bytes: Uint8Array }, options: { signal: AbortSignal }) => {
    void options;
    expect(Buffer.from(referenceImage.bytes)).toEqual(expectedSelectedFrame);
    return metaResult;
  });
  const meta = { editImage };
  const storage = {
    read: vi.fn(async (_identity: typeof identity, assetId: string) => {
      const asset = assets.get(assetId);
      if (!asset) throw new OwnedResourceNotFoundError();
      const { body, ...publicAsset } = asset;
      const result = {
        asset: {
          ...publicAsset,
          sizeBytes: body.byteLength,
          sha256: assetId === sourceAssetId ? sourceAssetSha256 : asset.sha256,
          projectId: assetId === sourceAssetId ? sourceProjectId : asset.projectId,
        },
        body: assetId === sourceAssetId ? sourceBytesCurrent : body,
      };
      return result;
    }),
    upload: vi.fn(async (_identity: typeof identity, request: { projectId: string; contentType: "image/png"; body: Uint8Array; metadata: Record<string, unknown> }) => {
      const id = randomUUID();
      const body = Buffer.from(request.body);
      const sha256Value = sha256(body);
      uploaded.push({ id, body, metadata: request.metadata, projectId: request.projectId, contentType: request.contentType, sha256: sha256Value });
      assets.set(id, { id, projectId: request.projectId, contentType: request.contentType, sizeBytes: body.byteLength, body, sha256: sha256Value, metadata: request.metadata });
      return { id, sha256: sha256Value, status: "ready" as const };
    }),
    delete: vi.fn(async (_identity: typeof identity, assetId: string) => { deleted.push(assetId); assets.delete(assetId); }),
  };
  const sandbox = {
    readFile: vi.fn(async (_projectId: string, path: string) => {
      if (path === "public/assets/generated/manifest.json") return { path, content: manifest };
      const file = workspaceFiles.get(path);
      if (typeof file !== "string") throw new Error("file_not_found");
      return { path, content: file };
    }),
    readBinaryFile: vi.fn(async (_projectId: string, path: string) => {
      const file = workspaceFiles.get(path);
      if (!(file instanceof Uint8Array)) throw new Error("file_not_found");
      return file;
    }),
    writeBinaryFile: vi.fn(async (_projectId: string, path: string, bytes: Uint8Array) => {
      workspaceFiles.set(path, Buffer.from(bytes));
      return { path, bytesWritten: bytes.byteLength };
    }),
    writeFile: vi.fn(async (_projectId: string, path: string, content: string) => {
      workspaceFiles.set(path, content);
      manifest = content;
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    }),
  };
  const context = {
    claim,
    projectId,
    signal: new AbortController().signal,
    beforeRequest: vi.fn(async () => undefined),
    onResponse: vi.fn(async (image: MetaImageResult) => { void image; }),
  };
  const tool = createEditSpriteTool({ meta, storage, sandbox, identity: vi.fn(async () => identity), now: () => new Date("2026-11-02T12:00:00.000Z") });
  return {
    tool, context, meta, storage, sandbox, uploaded, deleted, workspaceFiles,
    get sourceBytes() { return sourceBytes; }, sourceSha256,
    replaceSourceBytes(value: Buffer) {
      sourceBytesCurrent = value;
      const asset = assets.get(sourceAssetId)!;
      const checksum = sha256(value);
      asset.body = value;
      asset.sizeBytes = value.byteLength;
      asset.sha256 = checksum;
      asset.metadata = { ...asset.metadata, sha256: checksum, originalSha256: checksum };
      sourceAssetSha256 = checksum;
    },
    get sourceAssetSha256() { return sourceAssetSha256; },
    set sourceAssetSha256(value: string) { sourceAssetSha256 = value; },
    set sourceProjectId(value: string) { sourceProjectId = value; },
    readSourceBytes: () => sourceBytesCurrent,
  };
}

function sourceMeta(bytes: Uint8Array, sha256Value: string) {
  return GeneratedMetadata.parse({
    schemaVersion: 1,
    source: "meta-model-api",
    assetType: "sprite",
    model: "muse-image-1.0",
    prompt: "A source hero sprite for a local fixture.",
    createdAt: "2026-11-02T12:00:00.000Z",
    responseId: "resp_sprite_source_fixture",
    originalMimeType: "image/png",
    mimeType: "image/png",
    originalSha256: sha256Value,
    sha256: sha256Value,
    width: 48,
    height: 16,
    hasAlpha: true,
    transparentPixels: false,
    requestedTransparency: false,
    frames: { columns: 3, rows: 1, frameWidth: 16, frameHeight: 16 },
    edits: ["metadata-stripped", "png-reencoded"],
    qa: { contactSheetAssetId: "00000000-0000-4000-8000-000000000315", contactSheetSha256: sha256(Buffer.from("contact")), visualReview: "pending-in-live-preview" },
  });
}

async function makeStrip(): Promise<Buffer> {
  const colors = [
    { r: 35, g: 115, b: 230, alpha: 255 },
    { r: 235, g: 185, b: 40, alpha: 255 },
    { r: 180, g: 70, b: 225, alpha: 255 },
  ];
  const raw = Buffer.alloc(48 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 48; x += 1) {
      const color = colors[Math.floor(x / 16)]!;
      const offset = (y * 48 + x) * 4;
      raw[offset] = color.r;
      raw[offset + 1] = color.g;
      raw[offset + 2] = color.b;
      raw[offset + 3] = color.alpha;
    }
  }
  return sharp(raw, { raw: { width: 48, height: 16, channels: 4 } }).png().toBuffer();
}

async function cropFrame(bytes: Uint8Array, index: number): Promise<Buffer> {
  return sharp(bytes).extract({ left: index * 16, top: 0, width: 16, height: 16 })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

async function editResultImage(): Promise<MetaImageResult> {
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 23, g: 143, b: 138, alpha: 1 } } }).png().toBuffer();
  return { bytes, mimeType: "image/png", width: 16, height: 16, model: "muse-image-1.0", responseId: "resp_sprite_edit_fixture", requestId: "req_sprite_edit_fixture" };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
