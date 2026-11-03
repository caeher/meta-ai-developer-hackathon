import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseFromEnvironment, createRepositories, identityFromAuthenticatedSession, OwnedResourceNotFoundError, users } from "@meta-game/db";
import { createPrivateStorageFromEnvironment } from "@meta-game/storage";
import { createInspectAssetTool } from "../../apps/worker/src/assets/inspect-asset";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";

describe.skipIf(!integrationEnabled)("inspect_asset con PostgreSQL, Silo y ownership de proyecto", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const ownerA = `user_assetInspectA${suffix}`;
  const ownerB = `user_assetInspectB${suffix}`;
  const identityA = identityFromAuthenticatedSession({ userId: ownerA });
  const identityB = identityFromAuthenticatedSession({ userId: ownerB });
  let privateAssetId: string;
  let sameOwnerOtherProjectAssetId: string;
  let foreignOwnerAssetId: string;
  const unknownAssetId = randomUUID();
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;
  let storage: ReturnType<typeof createPrivateStorageFromEnvironment>;
  let projectA: string;
  let projectA2: string;
  let projectB: string;
  let inspect: ReturnType<typeof createInspectAssetTool>;

  beforeAll(async () => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
    storage = createPrivateStorageFromEnvironment(repositories.assets);
    const [first, sameOwnerProject, foreignProject] = await Promise.all([
      repositories.projects.create(identityA, { name: "Asset inspector A" }),
      repositories.projects.create(identityA, { name: "Asset inspector A2" }),
      repositories.projects.create(identityB, { name: "Asset inspector B" }),
    ]);
    projectA = first.id;
    projectA2 = sameOwnerProject.id;
    projectB = foreignProject.id;
    const bytes = await sharp({ create: { width: 24, height: 12, channels: 4, background: { r: 36, g: 150, b: 210, alpha: 1 } } }).png().toBuffer();
    const [own, sameOwnerAsset, foreignAsset] = await Promise.all([
      storage.upload(identityA, { projectId: projectA, contentType: "image/png", body: bytes, metadata: { source: "fixture", width: 24, height: 12 } }),
      storage.upload(identityA, { projectId: projectA2, contentType: "image/png", body: bytes, metadata: { source: "fixture", width: 24, height: 12 } }),
      storage.upload(identityB, { projectId: projectB, contentType: "image/png", body: bytes, metadata: { source: "fixture", width: 24, height: 12 } }),
    ]);
    privateAssetId = own.id;
    sameOwnerOtherProjectAssetId = sameOwnerAsset.id;
    foreignOwnerAssetId = foreignAsset.id;
    inspect = createInspectAssetTool({
      sandbox: {
        async readFile() { throw new Error("workspace_fixture_not_configured"); },
        async readBinaryFile() { throw new Error("workspace_fixture_not_configured"); },
      },
      storage,
      identity: async (claim) => claim.ownerUserId === ownerA ? identityA : identityB,
    });
  });

  afterAll(async () => {
    storage?.close();
    if (database) {
      await database.db.delete(users).where(inArray(users.userId, [ownerA, ownerB]));
      await database.close();
    }
  });

  it("lee una imagen Silo propia y oculta por igual assets inexistentes, ajenos y de otro proyecto", async () => {
    const claim = { runId: randomUUID(), ownerUserId: ownerA, projectId: projectA, fencingToken: 1 };
    const result = await inspect({ assetId: privateAssetId, kind: "auto", checks: ["decode", "dimensions"] }, { claim, projectId: projectA, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "valid", assetId: privateAssetId, kind: "image", dimensions: { width: 24, height: 12 } });

    const failures = await Promise.allSettled([sameOwnerOtherProjectAssetId, foreignOwnerAssetId, unknownAssetId].map((assetId) =>
      inspect({ assetId, kind: "image", checks: ["decode"] }, { claim, projectId: projectA, signal: new AbortController().signal }),
    ));
    expect(failures).toHaveLength(3);
    for (const failure of failures) expect(failure).toMatchObject({ status: "rejected", reason: expect.any(OwnedResourceNotFoundError) });
    if (failures.every((failure) => failure.status === "rejected")) {
      expect(failures.map((failure) => failure.reason.message)).toEqual(["Recurso no encontrado", "Recurso no encontrado", "Recurso no encontrado"]);
    }
  });
});
