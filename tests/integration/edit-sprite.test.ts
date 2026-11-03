import { createHash, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MetaImageResult } from "@meta-game/contracts";
import {
  createDatabaseFromEnvironment,
  createRepositories,
  identityFromAuthenticatedSession,
  OwnedResourceNotFoundError,
  users,
  type RunWorkerClaim,
} from "@meta-game/db";
import { createPrivateStorageFromEnvironment } from "@meta-game/storage";
import { createEditSpriteTool } from "../../apps/worker/src/assets/edit-sprite";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";

describe.skipIf(!integrationEnabled)("edit_sprite con PostgreSQL, Silo y ownership", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const ownerA = `user_spriteEditA${suffix}`;
  const ownerB = `user_spriteEditB${suffix}`;
  const identityA = identityFromAuthenticatedSession({ userId: ownerA });
  const identityB = identityFromAuthenticatedSession({ userId: ownerB });
  let claimA: RunWorkerClaim;
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;
  let storage: ReturnType<typeof createPrivateStorageFromEnvironment>;
  let projectA: string;
  let projectA2: string;
  let projectB: string;
  let sourceA: { id: string; bytes: Buffer; sha256: string };
  let sourceAOtherProject: { id: string; bytes: Buffer };
  let sourceB: { id: string; bytes: Buffer };
  const created: Array<{ identity: typeof identityA; id: string }> = [];

  beforeAll(async () => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
    storage = createPrivateStorageFromEnvironment(repositories.assets);
    const [a, a2, b] = await Promise.all([
      repositories.projects.create(identityA, { name: "Sprite edit owner A" }),
      repositories.projects.create(identityA, { name: "Sprite edit owner A second project" }),
      repositories.projects.create(identityB, { name: "Sprite edit owner B" }),
    ]);
    projectA = a.id;
    projectA2 = a2.id;
    projectB = b.id;
    claimA = { runId: randomUUID(), ownerUserId: ownerA, projectId: projectA, fencingToken: 1 };
    const bytes = await makeStrip();
    const checksum = sha256(bytes);
    const metadata = sourceMetadata(bytes, checksum);
    const [assetA, assetA2, assetB] = await Promise.all([
      storage.upload(identityA, { projectId: projectA, contentType: "image/png", body: bytes, metadata }),
      storage.upload(identityA, { projectId: projectA2, contentType: "image/png", body: bytes, metadata }),
      storage.upload(identityB, { projectId: projectB, contentType: "image/png", body: bytes, metadata }),
    ]);
    created.push({ identity: identityA, id: assetA.id }, { identity: identityA, id: assetA2.id }, { identity: identityB, id: assetB.id });
    sourceA = { id: assetA.id, bytes, sha256: checksum };
    sourceAOtherProject = { id: assetA2.id, bytes };
    sourceB = { id: assetB.id, bytes };
  });

  afterAll(async () => {
    if (storage) {
      for (const item of created.reverse()) await storage.delete(item.identity, item.id).catch(() => undefined);
      storage.close();
    }
    if (database) {
      await database.db.delete(users).where(inArray(users.userId, [ownerA, ownerB]));
      await database.close();
    }
  });

  it("lee el source por assetId, llama Meta con el frame elegido y persiste una derivación privada", async () => {
    const manifest = manifestFor([sourceA.id]);
    const sandbox = sandboxFor(manifest);
    const image = await editedImage();
    const editImage = vi.fn(async (_prompt: string, reference: { mimeType: "image/png"; bytes: Uint8Array }) => {
      expect(Buffer.from(reference.bytes)).toEqual(await cropFrame(sourceA.bytes, 1));
      return image;
    });
    const tool = createEditSpriteTool({ meta: { editImage }, storage, sandbox, identity: async () => identityA });
    const context = contextFor(projectA, claimA);
    const result = await tool(inputFor(sourceA.id), context);
    const sourceAfter = await storage.read(identityA, sourceA.id);
    const output = await storage.read(identityA, result.assetId);
    created.push({ identity: identityA, id: result.assetId });
    const contactSheetAssetId = (output.asset.metadata?.qa as { contactSheetAssetId?: unknown } | undefined)?.contactSheetAssetId;
    if (typeof contactSheetAssetId === "string") created.push({ identity: identityA, id: contactSheetAssetId });

    expect(result).toMatchObject({
      sourceAssetId: sourceA.id,
      sourceSha256: sourceA.sha256,
      sha256: output.asset.sha256,
      path: `assets/generated/${result.assetId}.png`,
      width: 16,
      height: 16,
      provenance: "meta-image-edit",
      reviewStatus: "pending-in-live-preview",
    });
    expect(output.asset.projectId).toBe(projectA);
    expect(output.asset.metadata).toMatchObject({
      provenance: "meta-image-edit",
      derivation: { sourceAssetId: sourceA.id, sourceSha256: sourceA.sha256, sourceFrameIndex: 1 },
    });
    expect(Buffer.from(sourceAfter.body)).toEqual(sourceA.bytes);
    expect(sourceAfter.asset.sha256).toBe(sourceA.sha256);
    expect(sandbox.files.get(`public/${result.path}`)).toEqual(output.body);
    expect(editImage).toHaveBeenCalledOnce();
    expect(context.beforeRequest).toHaveBeenCalledOnce();
    expect(context.onResponse).toHaveBeenCalledOnce();
  });

  it("oculta assets ajenos y de otro proyecto antes de reservar cuota o llamar Meta", async () => {
    for (const source of [sourceAOtherProject, sourceB]) {
      const sandbox = sandboxFor(manifestFor([source.id]));
      const editImage = vi.fn();
      const tool = createEditSpriteTool({ meta: { editImage }, storage, sandbox, identity: async () => identityA });
      const context = contextFor(projectA, claimA);
      await expect(tool(inputFor(source.id), context)).rejects.toBeInstanceOf(OwnedResourceNotFoundError);
      expect(editImage).not.toHaveBeenCalled();
      expect(context.beforeRequest).not.toHaveBeenCalled();
    }
  });
});

function inputFor(sourceAssetId: string) {
  return {
    sourceAssetId,
    sourceFrameIndex: 1,
    requestedChange: "Change the hero scarf to teal while preserving its outline.",
    palette: ["#178f8a"],
    preserve: { canvas: true, style: true, palette: true, characterIdentity: true },
  };
}

function contextFor(projectId: string, claim: RunWorkerClaim) {
  return {
    claim: { ...claim, projectId },
    projectId,
    signal: new AbortController().signal,
    beforeRequest: vi.fn(async () => undefined),
    onResponse: vi.fn(async () => undefined),
  };
}

function sandboxFor(manifest: string) {
  const files = new Map<string, string | Uint8Array>([["public/assets/generated/manifest.json", manifest]]);
  return {
    files,
    async readFile(_projectId: string, path: string) {
      const value = files.get(path);
      if (typeof value !== "string") throw new Error("file_not_found");
      return { path, content: value };
    },
    async writeBinaryFile(_projectId: string, path: string, bytes: Uint8Array) {
      files.set(path, Buffer.from(bytes));
      return { path, bytesWritten: bytes.byteLength };
    },
    async writeFile(_projectId: string, path: string, content: string) {
      files.set(path, content);
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    },
  };
}

function manifestFor(assetIds: string[]) {
  return JSON.stringify({
    schemaVersion: 1,
    assets: assetIds.map((assetId) => ({
      assetId,
      key: `generated-${assetId}`,
      path: `assets/generated/${assetId}.png`,
      assetType: "sprite",
      frameColumns: 3,
      frameRows: 1,
      frameWidth: 16,
      frameHeight: 16,
    })),
  });
}

async function makeStrip(): Promise<Buffer> {
  const colors = [{ r: 35, g: 115, b: 230 }, { r: 235, g: 185, b: 40 }, { r: 180, g: 70, b: 225 }];
  const raw = Buffer.alloc(48 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 48; x += 1) {
      const color = colors[Math.floor(x / 16)]!;
      const offset = (y * 48 + x) * 4;
      raw[offset] = color.r;
      raw[offset + 1] = color.g;
      raw[offset + 2] = color.b;
      raw[offset + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: 48, height: 16, channels: 4 } }).png().toBuffer();
}

function sourceMetadata(bytes: Uint8Array, checksum: string) {
  return {
    schemaVersion: 1,
    source: "meta-model-api",
    assetType: "sprite",
    model: "muse-image-1.0",
    prompt: "Source hero sprite for integration fixture.",
    createdAt: "2026-11-02T12:00:00.000Z",
    responseId: "resp_sprite_storage_fixture",
    originalMimeType: "image/png",
    mimeType: "image/png",
    originalSha256: checksum,
    sha256: checksum,
    width: 48,
    height: 16,
    hasAlpha: true,
    transparentPixels: false,
    requestedTransparency: false,
    frames: { columns: 3, rows: 1, frameWidth: 16, frameHeight: 16 },
    edits: ["metadata-stripped", "png-reencoded"],
    qa: { contactSheetAssetId: "00000000-0000-4000-8000-000000000316", contactSheetSha256: sha256(Buffer.from("contact")), visualReview: "pending-in-live-preview" },
  };
}

async function editedImage(): Promise<MetaImageResult> {
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 23, g: 143, b: 138, alpha: 1 } } }).png().toBuffer();
  return { bytes, mimeType: "image/png", width: 16, height: 16, model: "muse-image-1.0", responseId: "resp_sprite_edit_storage", requestId: "req_sprite_edit_storage", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
}

async function cropFrame(bytes: Uint8Array, index: number): Promise<Buffer> {
  return sharp(bytes).extract({ left: index * 16, top: 0, width: 16, height: 16 }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
