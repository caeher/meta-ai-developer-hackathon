import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { identityFromAuthenticatedSession, type RunWorkerClaim } from "@meta-game/db";
import type { MetaImageResult } from "@meta-game/contracts";
import { createGeneratedImageTool } from "../../apps/worker/src/assets/image-generator";

const claim: RunWorkerClaim = {
  runId: "00000000-0000-4000-8000-000000000101",
  ownerUserId: "00000000-0000-4000-8000-000000000102",
  projectId: "00000000-0000-4000-8000-000000000103",
  fencingToken: 2,
};
const identity = identityFromAuthenticatedSession({ userId: "user_assetFixture001" });
const brief = {
  assetType: "sprite",
  description: "A blue fox hero facing right",
  style: "crisp pixel art",
  view: "side",
  palette: ["#2468ac"],
  transparentBackground: true,
  frameColumns: 1,
  frameRows: 1,
  tileable: false,
};

async function validImage(): Promise<MetaImageResult> {
  const bytes = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 20, g: 80, b: 180, alpha: 0 } },
  }).png().toBuffer();
  return { bytes, mimeType: "image/png", width: 16, height: 16, model: "muse-image-1.0", responseId: "resp_asset_fixture", requestId: "req_asset_fixture" };
}

function harness(imageResult: MetaImageResult) {
  const calls: string[] = [];
  const uploaded: Array<{ id: string; body: Uint8Array; metadata: Record<string, unknown>; identity: unknown; projectId: string; contentType: string; sha256: string }> = [];
  const deleted: string[] = [];
  let manifest = JSON.stringify({ schemaVersion: 1, assets: [] });
  const meta = { generateImage: vi.fn(async (prompt: string, options: { signal: AbortSignal; referenceImage?: { mimeType: "image/png"; bytes: Uint8Array } }) => { calls.push(`meta:image:${prompt.length}:${Boolean(options.referenceImage)}`); return imageResult; }) };
  const storage = {
    read: vi.fn(async (_providedIdentity: typeof identity, id: string) => {
      calls.push(`storage:read:${id}`);
      const found = uploaded.find((asset) => asset.id === id);
      if (!found) throw new Error("asset_not_found");
      return {
        asset: {
          id: found.id,
          projectId: found.projectId,
          contentType: found.contentType,
          sizeBytes: found.body.byteLength,
          sha256: found.sha256,
          metadata: found.metadata,
        },
        body: found.body,
      };
    }),
    upload: vi.fn(async (providedIdentity: typeof identity, request: { projectId: string; contentType: string; body: Uint8Array; metadata: Record<string, unknown> }) => {
      calls.push("storage:upload");
      const id = randomUUID();
      const sha256 = createHash("sha256").update(request.body).digest("hex");
      uploaded.push({ id, body: request.body, metadata: request.metadata, identity: providedIdentity, projectId: request.projectId, contentType: request.contentType, sha256 });
      return { id, sha256, status: "ready" as const };
    }),
    delete: vi.fn(async (_providedIdentity: typeof identity, id: string) => { deleted.push(id); }),
  };
  const sandbox = {
    readFile: vi.fn(async (_projectId: string, path: string) => {
      calls.push(`sandbox:read:${path}`);
      return { path, content: manifest };
    }),
    writeBinaryFile: vi.fn(async (_projectId: string, path: string, bytes: Uint8Array) => {
      calls.push(`sandbox:write-binary:${path}`);
      return { path, bytesWritten: bytes.byteLength };
    }),
    writeFile: vi.fn(async (_projectId: string, path: string, contents: string) => {
      calls.push(`sandbox:write-text:${path}`);
      manifest = contents;
      return { path, bytesWritten: Buffer.byteLength(contents, "utf8") };
    }),
  };
  const imageTool = createGeneratedImageTool({
    meta,
    storage,
    sandbox,
    identity: vi.fn(async () => identity),
    now: () => new Date("2026-11-02T12:00:00.000Z"),
  });
  const context = {
    claim,
    projectId: claim.projectId,
    signal: new AbortController().signal,
    beforeRequest: vi.fn(async () => { calls.push("quota:reserved"); }),
    onResponse: vi.fn(async () => { calls.push("event:response-completed"); }),
  };
  return { calls, uploaded, deleted, meta, storage, sandbox, imageTool, context, get manifest() { return manifest; } };
}

describe("server-side generated asset integration", () => {
  it("reserves before Meta, stores private provenance, copies verified bytes, and registers Phaser loading metadata", async () => {
    const test = harness(await validImage());
    const result = await test.imageTool(brief, test.context);

    expect(test.calls.indexOf("quota:reserved")).toBeLessThan(
      test.calls.findIndex((call) => call.startsWith("meta:image:")),
    );
    expect(test.calls.indexOf("event:response-completed")).toBeLessThan(test.calls.indexOf("storage:upload"));
    expect(test.storage.upload).toHaveBeenCalledTimes(2);
    expect(test.uploaded.every((asset) => asset.identity === identity)).toBe(true);
    expect(test.uploaded[1]?.metadata).toMatchObject({
      source: "meta-model-api",
      model: "muse-image-1.0",
      createdAt: "2026-11-02T12:00:00.000Z",
      responseId: "resp_asset_fixture",
      requestId: "req_asset_fixture",
      originalMimeType: "image/png",
      mimeType: "image/png",
      hasAlpha: true,
      transparentPixels: true,
      requestedTransparency: true,
      qa: { visualReview: "pending-in-live-preview" },
    });
    expect(test.uploaded[1]?.metadata).not.toHaveProperty("reference");
    expect(result).toMatchObject({
      assetId: test.uploaded[1]?.id,
      contactSheetAssetId: test.uploaded[0]?.id,
      path: `assets/generated/${test.uploaded[1]?.id}.png`,
      manifestPath: "public/assets/generated/manifest.json",
      mimeType: "image/png",
      width: 16,
      height: 16,
      frameCount: 1,
      alphaVerified: true,
      qa: { visualReview: "pending-in-live-preview" },
    });
    expect(test.sandbox.writeBinaryFile).toHaveBeenCalledWith(
      claim.projectId,
      `public/assets/generated/${test.uploaded[1]?.id}.png`,
      expect.any(Uint8Array),
      test.context.signal,
    );
    expect(JSON.parse(test.manifest)).toEqual({
      schemaVersion: 1,
      assets: [{
        assetId: test.uploaded[1]?.id,
        key: `generated-${test.uploaded[1]?.id}`,
        path: `assets/generated/${test.uploaded[1]?.id}.png`,
        assetType: "sprite",
        frameColumns: 1,
        frameRows: 1,
        frameWidth: 16,
        frameHeight: 16,
      }],
    });
  });

  it("uses the latest generated image from the same project as a bounded style reference", async () => {
    const test = harness(await validImage());
    const first = await test.imageTool(brief, test.context);
    const referencedAsset = test.uploaded.find((asset) => asset.id === first.assetId)!;
    const second = await test.imageTool({ ...brief, description: "A blue fox companion facing left" }, test.context);

    expect(test.storage.read).toHaveBeenCalledWith(identity, first.assetId);
    expect(test.meta.generateImage.mock.calls[0]?.[1]).not.toHaveProperty("referenceImage");
    expect(test.meta.generateImage.mock.calls[1]?.[1]).toMatchObject({
      referenceImage: { mimeType: "image/png", bytes: expect.any(Uint8Array) },
    });
    expect(test.meta.generateImage.mock.calls[1]?.[0]).toContain("Use the supplied same-project reference image only to match its visual style");
    expect(test.uploaded.find((asset) => asset.id === second.assetId)?.metadata).toMatchObject({
      reference: { assetId: first.assetId, sha256: referencedAsset.sha256 },
    });
  });

  it("rejects a false alpha claim before storage or workspace writes", async () => {
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 20, g: 80, b: 180, alpha: 1 } },
    }).png().toBuffer();
    const test = harness({ ...await validImage(), bytes });

    await expect(test.imageTool(brief, test.context)).rejects.toMatchObject({ code: "generated_image_alpha_missing" });
    expect(test.storage.upload).not.toHaveBeenCalled();
    expect(test.sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });

  it("blocks sensitive briefs before quota reservation or a Meta request", async () => {
    const test = harness(await validImage());
    await expect(test.imageTool({ ...brief, description: "Email alice@example.com a new character portrait" }, test.context))
      .rejects.toThrow("agent_sensitive_content_blocked");
    expect(test.context.beforeRequest).not.toHaveBeenCalled();
    expect(test.meta.generateImage).not.toHaveBeenCalled();
    expect(test.storage.upload).not.toHaveBeenCalled();
  });

  it("deletes both private outputs if controlled workspace registration fails", async () => {
    const test = harness(await validImage());
    test.sandbox.writeBinaryFile.mockRejectedValue(new Error("sandbox unavailable"));

    await expect(test.imageTool(brief, test.context)).rejects.toThrow("sandbox unavailable");
    expect(test.storage.upload).toHaveBeenCalledTimes(2);
    expect(test.deleted).toEqual(test.uploaded.map((asset) => asset.id).reverse());
  });
});
