import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseFromEnvironment,
  createRepositories,
  identityFromAuthenticatedSession,
  OwnedResourceNotFoundError,
  users,
  type RunWorkerClaim,
} from "@meta-game/db";
import { createPrivateStorageFromEnvironment } from "@meta-game/storage";
import { createCreateTilesetTool } from "../../apps/worker/src/assets/create-tileset";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";

describe.skipIf(!integrationEnabled)("create_tileset con PostgreSQL, Silo y ownership", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const ownerA = `user_tilesetOwnerA${suffix}`;
  const ownerB = `user_tilesetOwnerB${suffix}`;
  const identityA = identityFromAuthenticatedSession({ userId: ownerA });
  const identityB = identityFromAuthenticatedSession({ userId: ownerB });
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;
  let storage: ReturnType<typeof createPrivateStorageFromEnvironment>;
  let projectA: string;
  let projectB: string;
  let sourceId: string;
  let claimA: RunWorkerClaim;
  const created: Array<{ identity: typeof identityA; id: string }> = [];

  beforeAll(async () => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
    storage = createPrivateStorageFromEnvironment(repositories.assets);
    const [projectForA, projectForB] = await Promise.all([
      repositories.projects.create(identityA, { name: "Tileset acceptance owner A" }),
      repositories.projects.create(identityB, { name: "Tileset acceptance owner B" }),
    ]);
    projectA = projectForA.id;
    projectB = projectForB.id;
    claimA = { runId: randomUUID(), ownerUserId: ownerA, projectId: projectA, fencingToken: 1 };
    const bytes = await makeSourceStrip();
    const checksum = sha256(bytes);
    const source = await storage.upload(identityA, {
      projectId: projectA,
      contentType: "image/png",
      body: bytes,
      metadata: sourceMetadata(checksum),
    });
    sourceId = source.id;
    created.push({ identity: identityA, id: source.id });
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

  it("compone, guarda los dos objetos en Silo y entrega bytes recuperados para la preview", async () => {
    const sandbox = makeSandbox(projectA, sourceId);
    const tool = createCreateTilesetTool({ storage, sandbox, identity: async () => identityA });
    const context = { claim: claimA, callId: "create-tileset-acceptance", projectId: projectA, signal: new AbortController().signal };
    const result = await tool(inputFor(sourceId), context);
    const imageStored = await storage.read(identityA, result.tilesetAssetId);
    const metadataAssetId = String(imageStored.asset.metadata?.metadataAssetId);
    const metadataStored = await storage.read(identityA, metadataAssetId);
    created.push({ identity: identityA, id: result.tilesetAssetId }, { identity: identityA, id: metadataAssetId });

    expect(result).toMatchObject({
      name: "acceptance_terrain",
      imagePath: `assets/generated/tilesets/${result.tilesetAssetId}.png`,
      metadataPath: `assets/generated/tilesets/${result.tilesetAssetId}.json`,
      sha256: imageStored.asset.sha256,
      tileSize: 16,
      columns: 2,
      rows: 2,
      tiles: [
        { tileIndex: 0, tileName: "water", collides: false, terrain: "water" },
        { tileIndex: 1, tileName: "ground", collides: true, terrain: "ground" },
        { tileIndex: 2, tileName: "wall", collides: true, terrain: "wall" },
        { tileIndex: 3, tileName: "decoration", collides: false, terrain: "decoration" },
      ],
    });
    expect(imageStored.asset.projectId).toBe(projectA);
    expect(metadataStored.asset.projectId).toBe(projectA);
    expect(Buffer.from(imageStored.body)).toEqual(Buffer.from(sandbox.files.get(`public/${result.imagePath}`) as Uint8Array));
    expect(Buffer.from(metadataStored.body)).toEqual(Buffer.from(sandbox.files.get(`public/${result.metadataPath}`) as string));
    expect(JSON.parse(String(sandbox.files.get("public/assets/generated/tilesets/manifest.json"))).tilesets).toHaveLength(1);

    const retry = await tool(inputFor(sourceId), context);
    expect(retry).toEqual(result);
    expect(JSON.parse(String(sandbox.files.get("public/assets/generated/tilesets/manifest.json"))).tilesets).toHaveLength(1);

    const artifactPath = process.env.ISSUE_32_TILESET_PREVIEW_ARTIFACT;
    if (artifactPath) {
      await writeFile(artifactPath, JSON.stringify({
        result,
        imageBase64: Buffer.from(imageStored.body).toString("base64"),
        metadataBase64: Buffer.from(metadataStored.body).toString("base64"),
      }), { encoding: "utf8", flag: "wx" });
    }
  });

  it("no empaqueta un asset de otro owner aunque su UUID aparezca en el manifest", async () => {
    const foreignSandbox = makeSandbox(projectB, sourceId);
    const claimB: RunWorkerClaim = { runId: randomUUID(), ownerUserId: ownerB, projectId: projectB, fencingToken: 1 };
    const tool = createCreateTilesetTool({ storage, sandbox: foreignSandbox, identity: async () => identityB });
    await expect(tool(inputFor(sourceId), {
      claim: claimB,
      callId: "foreign-tileset-source",
      projectId: projectB,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    expect(foreignSandbox.files.has("public/assets/generated/tilesets/manifest.json")).toBe(false);
  });
});

function inputFor(assetId: string) {
  return {
    name: "acceptance_terrain",
    tileSize: 16,
    columns: 2,
    layout: "input-order-row-major" as const,
    tiles: [
      { sourceAssetId: assetId, sourceFrameIndex: 0, tileName: "water", terrain: "water" as const },
      { sourceAssetId: assetId, sourceFrameIndex: 1, tileName: "ground", collides: true, terrain: "ground" as const },
      { sourceAssetId: assetId, sourceFrameIndex: 2, tileName: "wall", collides: true, terrain: "wall" as const },
      { sourceAssetId: assetId, sourceFrameIndex: 3, tileName: "decoration", terrain: "decoration" as const },
    ],
  };
}

function makeSandbox(_projectId: string, sourceAssetId: string) {
  const files = new Map<string, string | Uint8Array>([["public/assets/generated/manifest.json", JSON.stringify({
    schemaVersion: 1,
    assets: [{ assetId: sourceAssetId, key: `generated-${sourceAssetId}`, path: `assets/generated/${sourceAssetId}.png`, assetType: "tileset", frameColumns: 4, frameRows: 1, frameWidth: 16, frameHeight: 16 }],
  })]]);
  return {
    files,
    async readFile(_projectId: string, path: string) {
      const value = files.get(path);
      if (typeof value !== "string") throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return { path, content: value };
    },
    async readBinaryFile(_projectId: string, path: string) {
      const value = files.get(path);
      if (!(value instanceof Uint8Array)) throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return value;
    },
    async writeBinaryFile(_projectId: string, path: string, bytes: Uint8Array) {
      files.set(path, Buffer.from(bytes));
      return { path, bytesWritten: bytes.byteLength };
    },
    async writeFile(_projectId: string, path: string, content: string) {
      files.set(path, content);
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    },
    async deleteFile(_projectId: string, path: string) { return { path, deleted: files.delete(path) }; },
  };
}

async function makeSourceStrip(): Promise<Buffer> {
  const colors = [
    { r: 35, g: 115, b: 230 },
    { r: 38, g: 220, b: 80 },
    { r: 190, g: 70, b: 225 },
    { r: 230, g: 190, b: 35 },
  ];
  const raw = Buffer.alloc(64 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const color = colors[Math.floor(x / 16)]!;
      const offset = (y * 64 + x) * 4;
      raw[offset] = color.r;
      raw[offset + 1] = color.g;
      raw[offset + 2] = color.b;
      raw[offset + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: 64, height: 16, channels: 4 } }).png().toBuffer();
}

function sourceMetadata(checksum: string) {
  return {
    schemaVersion: 1,
    source: "meta-model-api",
    assetType: "tileset",
    model: "muse-image-1.0",
    prompt: "Four synthetic local terrain tiles for the Phaser acceptance fixture.",
    createdAt: "2026-11-03T00:00:00.000Z",
    responseId: "fixture-response-tileset",
    originalMimeType: "image/png",
    mimeType: "image/png",
    originalSha256: checksum,
    sha256: checksum,
    width: 64,
    height: 16,
    hasAlpha: true,
    transparentPixels: false,
    requestedTransparency: false,
    frames: { columns: 4, rows: 1, frameWidth: 16, frameHeight: 16 },
    edits: ["png-reencoded"],
    qa: { contactSheetAssetId: randomUUID(), contactSheetSha256: sha256(Buffer.from("fixture")), visualReview: "pending-in-live-preview" },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
