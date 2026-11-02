import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { GameDatabase } from "./database";
import { assets, messages, projectCleanupTasks, projectRunLocks, projects, publications, runEvents, runOutbox, runs, sandboxes, usageLedger, usageReservations, versions } from "./schema/index";

export type ClaimedProjectCleanup = Readonly<{
  id: string;
  ownerUserId: string;
  projectId: string;
  leaseToken: string;
}>;

export async function claimProjectCleanupBatch(database: GameDatabase, options: {
  now?: Date;
  limit?: number;
  leaseMs?: number;
  retentionDays?: number;
} = {}): Promise<ClaimedProjectCleanup[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 25;
  const leaseMs = options.leaseMs ?? 120_000;
  const retentionDays = options.retentionDays ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 10 * 60_000 ||
      !Number.isSafeInteger(retentionDays) || retentionDays < 0 || retentionDays > 3_650) throw new RangeError("Invalid project cleanup limits");
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
  return database.transaction(async (tx) => {
    const candidates = await tx.select({ task: projectCleanupTasks }).from(projectCleanupTasks)
      .innerJoin(projects, and(
        eq(projects.id, projectCleanupTasks.projectId), eq(projects.ownerUserId, projectCleanupTasks.ownerUserId),
      ))
      .where(and(
        isNotNull(projects.deletedAt), lte(projectCleanupTasks.createdAt, cutoff),
        or(
          sql`${projectCleanupTasks.status} in ('queued', 'failed')`,
          and(eq(projectCleanupTasks.status, "running"), or(isNull(projectCleanupTasks.leaseExpiresAt), lte(projectCleanupTasks.leaseExpiresAt, now))),
        ),
      ))
      .orderBy(projectCleanupTasks.createdAt)
      .limit(limit)
      .for("update", { of: projectCleanupTasks, skipLocked: true });
    const claimed: ClaimedProjectCleanup[] = [];
    for (const { task } of candidates) {
      const leaseToken = randomUUID();
      const [updated] = await tx.update(projectCleanupTasks).set({
        status: "running", leaseToken, leaseExpiresAt: new Date(now.getTime() + leaseMs),
        attempts: task.attempts + 1, lastErrorCode: null, updatedAt: now,
      }).where(and(
        eq(projectCleanupTasks.id, task.id),
        or(
          sql`${projectCleanupTasks.status} in ('queued', 'failed')`,
          and(eq(projectCleanupTasks.status, "running"), or(isNull(projectCleanupTasks.leaseExpiresAt), lte(projectCleanupTasks.leaseExpiresAt, now))),
        ),
      )).returning({ id: projectCleanupTasks.id, ownerUserId: projectCleanupTasks.ownerUserId, projectId: projectCleanupTasks.projectId });
      if (updated) claimed.push({ ...updated, leaseToken });
    }
    return claimed;
  });
}

export async function getProjectCleanupResources(database: GameDatabase, task: ClaimedProjectCleanup) {
  const now = new Date();
  const [ownedTask] = await database.select({ id: projectCleanupTasks.id }).from(projectCleanupTasks).innerJoin(projects, and(
    eq(projects.id, projectCleanupTasks.projectId), eq(projects.ownerUserId, projectCleanupTasks.ownerUserId),
  )).where(and(
    eq(projectCleanupTasks.id, task.id), eq(projectCleanupTasks.ownerUserId, task.ownerUserId), eq(projectCleanupTasks.projectId, task.projectId),
    eq(projectCleanupTasks.status, "running"), eq(projectCleanupTasks.leaseToken, task.leaseToken),
    sql`${projectCleanupTasks.leaseExpiresAt} > ${now}`, isNotNull(projects.deletedAt),
  )).limit(1);
  if (!ownedTask) return undefined;
  const [sandbox] = await database.select({
    id: sandboxes.id,
    status: sandboxes.status,
    lifecycleSnapshotId: sandboxes.lifecycleSnapshotId,
  }).from(sandboxes).where(and(
    eq(sandboxes.ownerUserId, task.ownerUserId), eq(sandboxes.projectId, task.projectId),
  )).limit(1);
  const assetRows = await database.select({ id: assets.id, objectKey: assets.objectKey }).from(assets).where(and(
    eq(assets.ownerUserId, task.ownerUserId), eq(assets.projectId, task.projectId),
  ));
  const versionRows = await database.select({ id: versions.id }).from(versions).where(and(
    eq(versions.ownerUserId, task.ownerUserId), eq(versions.projectId, task.projectId),
  ));
  const publicationRows = await database.select({ slug: publications.slug }).from(publications).where(and(
    eq(publications.ownerUserId, task.ownerUserId), eq(publications.projectId, task.projectId),
  ));
  const runRows = await database.select({ id: runs.id }).from(runs).where(and(
    eq(runs.ownerUserId, task.ownerUserId), eq(runs.projectId, task.projectId),
  ));
  const runJobs = await database.select({ runId: runOutbox.runId, generation: runOutbox.generation }).from(runOutbox).where(and(
    eq(runOutbox.ownerUserId, task.ownerUserId), eq(runOutbox.projectId, task.projectId),
  ));
  return {
    sandbox,
    assets: assetRows,
    versions: versionRows,
    publications: publicationRows,
    runIds: runRows.map(({ id }) => id),
    runJobs,
  };
}

export async function failProjectCleanup(database: GameDatabase, task: ClaimedProjectCleanup, errorCode: string): Promise<void> {
  const safeCode = /^[a-z][a-z0-9_]{0,79}$/.test(errorCode) ? errorCode : "resource_cleanup_failed";
  const now = new Date();
  await database.update(projectCleanupTasks).set({
    status: "failed", lastErrorCode: safeCode, leaseToken: null, leaseExpiresAt: null, updatedAt: now,
  }).where(and(
    eq(projectCleanupTasks.id, task.id), eq(projectCleanupTasks.ownerUserId, task.ownerUserId),
    eq(projectCleanupTasks.projectId, task.projectId), eq(projectCleanupTasks.status, "running"),
    eq(projectCleanupTasks.leaseToken, task.leaseToken),
  ));
}

export async function completeProjectCleanup(database: GameDatabase, task: ClaimedProjectCleanup): Promise<boolean> {
  const now = new Date();
  return database.transaction(async (tx) => {
    const [ownedTask] = await tx.select({ id: projectCleanupTasks.id }).from(projectCleanupTasks).innerJoin(projects, and(
      eq(projects.id, projectCleanupTasks.projectId), eq(projects.ownerUserId, projectCleanupTasks.ownerUserId),
    )).where(and(
      eq(projectCleanupTasks.id, task.id), eq(projectCleanupTasks.ownerUserId, task.ownerUserId),
      eq(projectCleanupTasks.projectId, task.projectId), eq(projectCleanupTasks.status, "running"),
      eq(projectCleanupTasks.leaseToken, task.leaseToken), sql`${projectCleanupTasks.leaseExpiresAt} > ${now}`,
      isNotNull(projects.deletedAt),
    )).for("update", { of: projectCleanupTasks }).limit(1);
    if (!ownedTask) return false;
    const byProject = and(eq(messages.ownerUserId, task.ownerUserId), eq(messages.projectId, task.projectId));
    await tx.delete(messages).where(byProject);
    await tx.delete(runEvents).where(and(eq(runEvents.ownerUserId, task.ownerUserId), eq(runEvents.projectId, task.projectId)));
    await tx.delete(runOutbox).where(and(eq(runOutbox.ownerUserId, task.ownerUserId), eq(runOutbox.projectId, task.projectId)));
    await tx.delete(projectRunLocks).where(and(eq(projectRunLocks.ownerUserId, task.ownerUserId), eq(projectRunLocks.projectId, task.projectId)));
    await tx.delete(usageLedger).where(and(eq(usageLedger.ownerUserId, task.ownerUserId), eq(usageLedger.projectId, task.projectId)));
    await tx.delete(usageReservations).where(and(eq(usageReservations.ownerUserId, task.ownerUserId), eq(usageReservations.projectId, task.projectId)));
    await tx.delete(publications).where(and(eq(publications.ownerUserId, task.ownerUserId), eq(publications.projectId, task.projectId)));
    await tx.delete(versions).where(and(eq(versions.ownerUserId, task.ownerUserId), eq(versions.projectId, task.projectId)));
    await tx.delete(assets).where(and(eq(assets.ownerUserId, task.ownerUserId), eq(assets.projectId, task.projectId)));
    await tx.delete(sandboxes).where(and(eq(sandboxes.ownerUserId, task.ownerUserId), eq(sandboxes.projectId, task.projectId)));
    await tx.delete(runs).where(and(eq(runs.ownerUserId, task.ownerUserId), eq(runs.projectId, task.projectId)));
    const [completed] = await tx.update(projectCleanupTasks).set({
      status: "succeeded", leaseToken: null, leaseExpiresAt: null, lastErrorCode: null, completedAt: now, updatedAt: now,
    }).where(and(
      eq(projectCleanupTasks.id, task.id), eq(projectCleanupTasks.status, "running"),
      eq(projectCleanupTasks.leaseToken, task.leaseToken),
    )).returning({ id: projectCleanupTasks.id });
    return Boolean(completed);
  });
}
