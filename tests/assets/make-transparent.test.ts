import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { identityFromAuthenticatedSession, type RunWorkerClaim } from "@meta-game/db";
import { MakeTransparentResultSchema } from "@meta-game/contracts";
import { createMakeTransparentTool } from "../../apps/worker/src/assets/make-transparent";

const projectId = "00000000-0000-4000-8000-000000000401";
const sourceAssetId = "00000000-0000-4000-8000-000000000402";
const claim: RunWorkerClaim = { runId: "00000000-0000-4000-8000-000000000403", ownerUserId: "user_transparencyFixture1", projectId, fencingToken: 1 };
const identity = identityFromAuthenticatedSession({ userId: claim.ownerUserId });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function harness() {
  const raw = Buffer.alloc(4 * 4 * 4, 255);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) { const o = (y * 4 + x) * 4; raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30; }
  const sourceBytes = await sharp(raw, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
  const sourceSha = sha(sourceBytes);
  const metadata = {
    schemaVersion: 1, source: "meta-model-api", assetType: "sprite", model: "muse-image-1.0", prompt: "hero", createdAt: "2026-11-03T00:00:00.000Z",
    responseId: "resp-1", originalMimeType: "image/png", mimeType: "image/png", originalSha256: sourceSha, sha256: sourceSha,
    width: 4, height: 4, hasAlpha: false, transparentPixels: false, requestedTransparency: false,
    frames: { columns: 1, rows: 1, frameWidth: 4, frameHeight: 4 }, edits: [],
    qa: { contactSheetAssetId: "00000000-0000-4000-8000-000000000404", contactSheetSha256: "b".repeat(64), visualReview: "pending-in-live-preview" },
  };
  const uploads = new Map<string, { body: Buffer; metadata: Record<string, unknown> }>();
  const storage = {
    read: vi.fn(async () => ({ asset: { id: sourceAssetId, projectId, contentType: "image/png", sizeBytes: sourceBytes.byteLength, sha256: sourceSha, metadata }, body: sourceBytes })),
    upload: vi.fn(async (_id: unknown, req: { body: Uint8Array; metadata: Record<string, unknown> }) => { const id = randomUUID(); uploads.set(id, { body: Buffer.from(req.body), metadata: req.metadata }); return { id, sha256: sha(req.body), status: "ready" as const }; }),
    delete: vi.fn(async (_id: unknown, assetId: string) => { uploads.delete(assetId); }),
  };
  const files = new Map<string, string | Uint8Array>();
  files.set("public/assets/generated/manifest.json", JSON.stringify({ schemaVersion: 1, assets: [{ assetId: sourceAssetId, key: `generated-${sourceAssetId}`, path: `assets/generated/${sourceAssetId}.png`, assetType: "sprite", frameColumns: 1, frameRows: 1, frameWidth: 4, frameHeight: 4 }] }));
  const sandbox = {
    readFile: vi.fn(async (_p: string, path: string) => ({ path, content: String(files.get(path) ?? "") })),
    writeFile: vi.fn(async (_p: string, path: string, content: string) => { files.set(path, content); return { path, bytesWritten: Buffer.byteLength(content) }; }),
    writeBinaryFile: vi.fn(async (_p: string, path: string, body: Uint8Array) => { files.set(path, Buffer.from(body)); return { path, bytesWritten: body.byteLength }; }),
  };
  const tool = createMakeTransparentTool({ storage: storage as never, sandbox: sandbox as never, identity: async () => identity });
  return { tool, uploads, files, sourceBytes };
}

describe("make_transparent tool", () => {
  it("creates a new transparent asset, keeps the source and registers it for pack_spritesheet", async () => {
    const { tool, uploads, files, sourceBytes } = await harness();
    const result = await tool({ sourceAssetId, mode: "corner-flood", tolerance: 10 }, { claim, callId: "call-1", projectId, signal: new AbortController().signal });
    expect(MakeTransparentResultSchema.safeParse(result).success).toBe(true);
    expect(result.assetId).not.toBe(sourceAssetId);
    expect(result.removedPixels).toBe(12);
    expect(uploads.get(result.assetId)?.body.byteLength).toBeGreaterThan(0);
    const manifest = JSON.parse(String(files.get("public/assets/generated/manifest.json"))) as { assets: Array<{ assetId: string }> };
    expect(manifest.assets.map((a) => a.assetId)).toContain(result.assetId);
    expect(files.get(`public/${result.path}`)).toBeDefined();
    expect(sourceBytes.byteLength).toBeGreaterThan(0);
  });
  it("rejects an unregistered source before writing", async () => {
    const { tool } = await harness();
    await expect(tool({ sourceAssetId: "00000000-0000-4000-8000-000000000499", mode: "corner-flood" }, { claim, callId: "c2", projectId, signal: new AbortController().signal })).rejects.toThrow();
  });
});