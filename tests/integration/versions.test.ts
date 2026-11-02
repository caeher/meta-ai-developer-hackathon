import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseFromEnvironment,
  createRepositories,
  identityFromAuthenticatedSession,
  ProjectRunBusyError,
  users,
} from "@meta-game/db";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";

describe.skipIf(!integrationEnabled)("versiones privadas y restauración serializada", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const clerkA = `user_versionsA${suffix}`;
  const clerkB = `user_versionsB${suffix}`;
  const identityA = identityFromAuthenticatedSession({ userId: clerkA });
  const identityB = identityFromAuthenticatedSession({ userId: clerkB });
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;

  beforeAll(() => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
  });

  afterAll(async () => {
    if (database) {
      await database.db.delete(users).where(inArray(users.clerkUserId, [clerkA, clerkB]));
      await database.close();
    }
  });

  it("lista versiones ready, vincula el parent y oculta versiones de otro owner", async () => {
    const project = await repositories.projects.create(identityA, { name: "Historial privado" });
    const first = await repositories.versions.create(identityA, {
      projectId: project.id,
      sha256: "a".repeat(64),
      sizeBytes: 320,
      manifest: { files: [{ path: "src/main.ts", sha256: "1".repeat(64) }], changes: { added: ["src/main.ts"], modified: [], removed: [] } },
    });
    await repositories.versions.setStatus(identityA, first.id, "ready");
    const second = await repositories.versions.create(identityA, {
      projectId: project.id,
      sha256: "b".repeat(64),
      sizeBytes: 410,
      parentVersionId: first.id,
      manifest: { files: [{ path: "src/main.ts", sha256: "2".repeat(64) }], changes: { added: [], modified: ["src/main.ts"], removed: [] } },
    });
    await repositories.versions.setStatus(identityA, second.id, "ready");
    const pending = await repositories.versions.create(identityA, { projectId: project.id, sha256: "c".repeat(64), sizeBytes: 0 });
    await repositories.projects.create(identityB, { name: "Otro propietario" });

    expect(second.parentVersionId).toBe(first.id);
    expect((await repositories.versions.list(identityA, project.id)).items.map((version) => version.id)).toEqual([second.id, first.id]);
    expect(await repositories.versions.get(identityB, project.id, first.id)).toBeUndefined();
    expect(await repositories.versions.get(identityA, project.id, pending.id)).toBeUndefined();
    expect((await repositories.versions.latest(identityA, project.id))?.id).toBe(second.id);
  });

  it("serializa version numbers concurrentes y bloquea dos restores simultáneos", async () => {
    const project = await repositories.projects.create(identityA, { name: "Restore concurrente" });
    const versions = await Promise.all(["d", "e", "f"].map((letter) => repositories.versions.create(identityA, {
      projectId: project.id,
      sha256: letter.repeat(64),
      sizeBytes: 128,
    })));
    expect(versions.map((version) => version.versionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3]);

    const lock = await repositories.versions.acquireRestoreLock(identityA, project.id);
    await expect(repositories.versions.acquireRestoreLock(identityA, project.id)).rejects.toBeInstanceOf(ProjectRunBusyError);
    await repositories.versions.renewRestoreLock(identityA, lock);
    await repositories.versions.releaseRestoreLock(identityA, lock);
    const next = await repositories.versions.acquireRestoreLock(identityA, project.id);
    await repositories.versions.releaseRestoreLock(identityA, next);
  });

  it("confirma una versión restaurada solo bajo su fencing lock activo", async () => {
    const project = await repositories.projects.create(identityA, { name: "Versión restaurada" });
    const source = await repositories.versions.create(identityA, { projectId: project.id, sha256: "a".repeat(64), sizeBytes: 100 });
    await repositories.versions.setStatus(identityA, source.id, "ready");
    const lock = await repositories.versions.acquireRestoreLock(identityA, project.id);
    const restored = await repositories.versions.createRestored(identityA, lock, {
      versionId: randomUUID(), projectId: project.id, sha256: "b".repeat(64), sizeBytes: 120,
      parentVersionId: source.id, manifest: { files: [{ path: "src/main.ts", sha256: "2".repeat(64) }] },
    });
    expect(restored).toMatchObject({ status: "creating", versionNumber: 2, parentVersionId: source.id, runId: null });
    const ready = await repositories.versions.markRestoredSnapshotReady(identityA, lock, restored.id);
    expect(ready.status).toBe("ready");
    const pending = await repositories.versions.create(identityA, {
      projectId: project.id, sha256: "d".repeat(64), sizeBytes: 120,
      parentVersionId: source.id,
    });
    const cutoff = new Date(Date.now() + 1_000);
    const candidate = (await repositories.versions.listSnapshotReconciliationCandidates(cutoff, 250)).find((row) => row.id === pending.id);
    expect(candidate?.id).toBe(pending.id);
    expect(await repositories.versions.reconcileSnapshotCandidate({
      id: pending.id, ownerUserId: pending.ownerUserId, projectId: pending.projectId,
      sha256: pending.sha256, sizeBytes: pending.sizeBytes, createdAt: pending.createdAt,
      cutoff, status: "failed",
    })).toBe(true);
    expect((await repositories.versions.list(identityA, project.id)).items.map((version) => version.id)).not.toContain(pending.id);
    await repositories.versions.releaseRestoreLock(identityA, lock);
    await expect(repositories.versions.createRestored(identityA, lock, {
      versionId: randomUUID(), projectId: project.id, sha256: "c".repeat(64), sizeBytes: 120,
      parentVersionId: source.id,
    })).rejects.toThrow();
  });
});
