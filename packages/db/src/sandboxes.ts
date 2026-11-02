import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { GameDatabase } from "./database";
import { assets, projectRunLocks, projects, runs, sandboxes, usageReservations, users, versions } from "./schema/index";

export type SandboxState = "provisioning" | "ready" | "suspending" | "suspended" | "stopping" | "stopped" | "failed";
export type SandboxRecord = Readonly<{
  id: string;
  ownerUserId: string;
  projectId: string;
  runtimeUid: number;
  runtimeId: string | null;
  status: SandboxState;
  leaseExpiresAt: Date | null;
  devServerStatus: "stopped" | "starting" | "ready" | "failed";
  devServerPort: number | null;
  devServerLeaseExpiresAt: Date | null;
  lifecycleLeaseToken: string | null;
  lifecycleLeaseExpiresAt: Date | null;
  lifecycleSnapshotId: string | null;
  lifecycleSnapshotSha256: string | null;
  lifecycleSnapshotSizeBytes: number | null;
  updatedAt: Date;
}>;

export class SandboxProjectNotFoundError extends Error {
  constructor() { super("project_not_found"); this.name = "SandboxProjectNotFoundError"; }
}

export class SandboxOperationConflictError extends Error {
  constructor() { super("sandbox_operation_conflict"); this.name = "SandboxOperationConflictError"; }
}

export async function createOrGetProjectSandbox(database: GameDatabase, projectId: string): Promise<SandboxRecord> {
  return database.transaction(async (tx) => {
    const [project] = await tx.select({ ownerUserId: projects.ownerUserId }).from(projects).where(and(
      eq(projects.id, projectId), isNull(projects.deletedAt),
    )).for("update").limit(1);
    if (!project) throw new SandboxProjectNotFoundError();
    const [existing] = await tx.select().from(sandboxes).where(and(
      eq(sandboxes.ownerUserId, project.ownerUserId), eq(sandboxes.projectId, projectId),
    )).for("update").limit(1);
    if (existing) {
      if (existing.status === "stopping" || existing.status === "suspending") throw new SandboxOperationConflictError();
      return existing as SandboxRecord;
    }
    const [created] = await tx.insert(sandboxes).values({
      ownerUserId: project.ownerUserId,
      projectId,
      status: "provisioning",
    }).returning();
    if (!created) throw new Error("sandbox_record_create_failed");
    return created as SandboxRecord;
  });
}

export async function getProjectSandbox(database: GameDatabase, projectId: string): Promise<SandboxRecord | undefined> {
  const [record] = await database.select({ sandbox: sandboxes })
    .from(sandboxes)
    .innerJoin(projects, and(
      eq(projects.ownerUserId, sandboxes.ownerUserId), eq(projects.id, sandboxes.projectId),
    ))
    .where(and(eq(sandboxes.projectId, projectId), isNull(projects.deletedAt)))
    .limit(1);
  return record?.sandbox as SandboxRecord | undefined;
}

/** Internal cleanup lookup; callers must already hold the controller service token. */
export async function getProjectSandboxForCleanup(database: GameDatabase, projectId: string): Promise<SandboxRecord | undefined> {
  const [record] = await database.select().from(sandboxes).where(eq(sandboxes.projectId, projectId)).limit(1);
  return record as SandboxRecord | undefined;
}

export async function updateProjectSandbox(
  database: GameDatabase,
  record: Pick<SandboxRecord, "id" | "ownerUserId" | "projectId">,
  patch: {
    status: SandboxState;
    runtimeId?: string | null;
    leaseExpiresAt?: Date | null;
    devServerStatus?: SandboxRecord["devServerStatus"];
    devServerPort?: number | null;
    devServerLeaseExpiresAt?: Date | null;
    lifecycleLeaseToken?: string | null;
    lifecycleLeaseExpiresAt?: Date | null;
    lifecycleSnapshotId?: string | null;
    lifecycleSnapshotSha256?: string | null;
    lifecycleSnapshotSizeBytes?: number | null;
  },
): Promise<void> {
  const [updated] = await database.update(sandboxes).set({
    status: patch.status,
    ...(patch.runtimeId !== undefined ? { runtimeId: patch.runtimeId } : {}),
    ...(patch.leaseExpiresAt !== undefined ? { leaseExpiresAt: patch.leaseExpiresAt } : {}),
    ...(patch.devServerStatus !== undefined ? { devServerStatus: patch.devServerStatus } : {}),
    ...(patch.devServerPort !== undefined ? { devServerPort: patch.devServerPort } : {}),
    ...(patch.devServerLeaseExpiresAt !== undefined ? { devServerLeaseExpiresAt: patch.devServerLeaseExpiresAt } : {}),
    ...(patch.lifecycleLeaseToken !== undefined ? { lifecycleLeaseToken: patch.lifecycleLeaseToken } : {}),
    ...(patch.lifecycleLeaseExpiresAt !== undefined ? { lifecycleLeaseExpiresAt: patch.lifecycleLeaseExpiresAt } : {}),
    ...(patch.lifecycleSnapshotId !== undefined ? { lifecycleSnapshotId: patch.lifecycleSnapshotId } : {}),
    ...(patch.lifecycleSnapshotSha256 !== undefined ? { lifecycleSnapshotSha256: patch.lifecycleSnapshotSha256 } : {}),
    ...(patch.lifecycleSnapshotSizeBytes !== undefined ? { lifecycleSnapshotSizeBytes: patch.lifecycleSnapshotSizeBytes } : {}),
    updatedAt: new Date(),
  }).where(and(
    eq(sandboxes.id, record.id),
    eq(sandboxes.ownerUserId, record.ownerUserId),
    eq(sandboxes.projectId, record.projectId),
  )).returning({ id: sandboxes.id });
  if (!updated) throw new SandboxProjectNotFoundError();
}

export async function touchProjectSandbox(
  database: GameDatabase,
  record: Pick<SandboxRecord, "id" | "ownerUserId" | "projectId">,
  leaseExpiresAt: Date,
): Promise<boolean> {
  const now = new Date();
  const [updated] = await database.update(sandboxes).set({
    leaseExpiresAt,
    devServerLeaseExpiresAt: sql`case when ${sandboxes.devServerStatus} = 'ready' then ${leaseExpiresAt} else ${sandboxes.devServerLeaseExpiresAt} end`,
    updatedAt: now,
  }).where(and(
    eq(sandboxes.id, record.id), eq(sandboxes.ownerUserId, record.ownerUserId), eq(sandboxes.projectId, record.projectId),
    eq(sandboxes.status, "ready"),
    gt(sandboxes.leaseExpiresAt, now),
  )).returning({ id: sandboxes.id });
  return Boolean(updated);
}

export async function claimProjectDevServerStart(
  database: GameDatabase,
  record: Pick<SandboxRecord, "id" | "ownerUserId" | "projectId">,
  input: { port: number; serverLeaseExpiresAt: Date; sandboxLeaseExpiresAt: Date },
): Promise<boolean> {
  const now = new Date();
  const reclaimableServer = or(
    inArray(sandboxes.devServerStatus, ["stopped", "failed"]),
    and(eq(sandboxes.devServerStatus, "ready"), or(
      isNull(sandboxes.devServerLeaseExpiresAt), lte(sandboxes.devServerLeaseExpiresAt, now),
    )),
    and(eq(sandboxes.devServerStatus, "starting"), lte(sandboxes.devServerLeaseExpiresAt, now)),
  );
  const [updated] = await database.update(sandboxes).set({
    status: "ready",
    leaseExpiresAt: input.sandboxLeaseExpiresAt,
    devServerStatus: "starting",
    devServerPort: input.port,
    devServerLeaseExpiresAt: input.serverLeaseExpiresAt,
    updatedAt: now,
  }).where(and(
    eq(sandboxes.id, record.id),
    eq(sandboxes.ownerUserId, record.ownerUserId),
    eq(sandboxes.projectId, record.projectId),
    eq(sandboxes.status, "ready"),
    gt(sandboxes.leaseExpiresAt, now),
    reclaimableServer,
  )).returning({ id: sandboxes.id });
  return Boolean(updated);
}

export async function claimExpiredSandboxes(database: GameDatabase, limit = 50): Promise<SandboxRecord[]> {
  return database.transaction(async (tx) => {
    const now = new Date();
    const staleStoppingCutoff = new Date(now.getTime() - 120_000);
    const expiredRows = await tx.select({ sandbox: sandboxes }).from(sandboxes)
      .innerJoin(projects, and(eq(projects.ownerUserId, sandboxes.ownerUserId), eq(projects.id, sandboxes.projectId)))
      .where(and(isNull(projects.deletedAt), or(
      and(inArray(sandboxes.status, ["stopped", "failed"]), or(
        isNull(sandboxes.leaseExpiresAt), lte(sandboxes.leaseExpiresAt, now),
      )),
      and(eq(sandboxes.status, "stopping"), lte(sandboxes.updatedAt, staleStoppingCutoff)),
    ))).orderBy(sandboxes.updatedAt).limit(limit).for("update", { of: sandboxes, skipLocked: true });
    const expired = expiredRows.map(({ sandbox }) => sandbox);
    const claimed: SandboxRecord[] = [];
    for (const record of expired) {
      const currentCondition = record.status === "stopping"
          ? and(eq(sandboxes.status, "stopping"), lte(sandboxes.updatedAt, staleStoppingCutoff))
          : and(eq(sandboxes.status, record.status), or(isNull(sandboxes.leaseExpiresAt), lte(sandboxes.leaseExpiresAt, now)));
      const [updated] = await tx.update(sandboxes).set({ status: "stopping", updatedAt: now }).where(and(
        eq(sandboxes.id, record.id), currentCondition,
      )).returning();
      if (updated) claimed.push(updated as SandboxRecord);
    }
    return claimed;
  });
}

export async function claimDeletedProjectSandboxes(database: GameDatabase, options: { limit?: number; leaseMs?: number; now?: Date } = {}) {
  const limit = options.limit ?? 25;
  const leaseMs = options.leaseMs ?? 120_000;
  const now = options.now ?? new Date();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 10 * 60_000) {
    throw new RangeError("Invalid deleted sandbox sweep limits");
  }
  return database.transaction(async (tx) => {
    const candidates = await tx.select({ sandbox: sandboxes }).from(sandboxes)
      .innerJoin(projects, and(eq(projects.id, sandboxes.projectId), eq(projects.ownerUserId, sandboxes.ownerUserId)))
      .where(and(
        isNotNull(projects.deletedAt), inArray(sandboxes.status, ["stopping", "failed"]),
        or(isNull(sandboxes.lifecycleLeaseExpiresAt), lte(sandboxes.lifecycleLeaseExpiresAt, now)),
      )).orderBy(sandboxes.updatedAt).limit(limit).for("update", { of: sandboxes, skipLocked: true });
    const claimed = [] as Array<SandboxRecord & { lifecycleLeaseToken: string }>;
    for (const { sandbox } of candidates) {
      const lifecycleLeaseToken = randomUUID();
      const [updated] = await tx.update(sandboxes).set({
        status: "stopping", lifecycleLeaseToken,
        lifecycleLeaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now,
      }).where(and(
        eq(sandboxes.id, sandbox.id), inArray(sandboxes.status, ["stopping", "failed"]),
        or(isNull(sandboxes.lifecycleLeaseExpiresAt), lte(sandboxes.lifecycleLeaseExpiresAt, now)),
      )).returning();
      if (updated) claimed.push({ ...updated, lifecycleLeaseToken } as SandboxRecord & { lifecycleLeaseToken: string });
    }
    return claimed;
  });
}

export async function releaseDeletedProjectSandboxLease(database: GameDatabase, record: Pick<SandboxRecord, "id" | "ownerUserId" | "projectId">, leaseToken: string): Promise<void> {
  await database.update(sandboxes).set({ lifecycleLeaseToken: null, lifecycleLeaseExpiresAt: null, updatedAt: new Date() }).where(and(
    eq(sandboxes.id, record.id), eq(sandboxes.ownerUserId, record.ownerUserId), eq(sandboxes.projectId, record.projectId),
    eq(sandboxes.status, "stopping"), eq(sandboxes.lifecycleLeaseToken, leaseToken),
  ));
}

export async function claimIdleSandboxes(database: GameDatabase, options: { limit?: number; leaseMs?: number; graceSeconds?: number; now?: Date } = {}) {
  const limit = options.limit ?? 25;
  const leaseMs = options.leaseMs ?? 120_000;
  const graceSeconds = options.graceSeconds ?? 0;
  const now = options.now ?? new Date();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 10 * 60_000 ||
      !Number.isSafeInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 86_400) {
    throw new RangeError("Invalid lifecycle sweep limits");
  }
  const idleCutoff = new Date(now.getTime() - graceSeconds * 1000);
  return database.transaction(async (tx) => {
    const idleReady = and(
      eq(sandboxes.status, "ready"),
      or(isNull(sandboxes.leaseExpiresAt), lte(sandboxes.leaseExpiresAt, idleCutoff)),
      or(isNull(sandboxes.devServerLeaseExpiresAt), lte(sandboxes.devServerLeaseExpiresAt, idleCutoff)),
    );
    const interruptedSuspension = and(
      inArray(sandboxes.status, ["stopping", "suspending", "suspended", "failed"]),
      isNotNull(sandboxes.lifecycleLeaseToken),
      or(isNull(sandboxes.lifecycleLeaseExpiresAt), lte(sandboxes.lifecycleLeaseExpiresAt, now)),
    );
    const candidates = await tx.select({ sandbox: sandboxes })
      .from(sandboxes)
      .innerJoin(projects, and(eq(projects.id, sandboxes.projectId), eq(projects.ownerUserId, sandboxes.ownerUserId)))
      .where(and(
        isNull(projects.deletedAt), eq(projects.isInternal, false),
        or(idleReady, interruptedSuspension),
        or(isNull(sandboxes.lifecycleLeaseExpiresAt), lte(sandboxes.lifecycleLeaseExpiresAt, now)),
      ))
      .orderBy(sandboxes.updatedAt)
      .limit(limit)
      .for("update", { of: sandboxes, skipLocked: true });
    const claimed = [] as Array<SandboxRecord & { lifecycleLeaseToken: string }>;
    for (const { sandbox } of candidates) {
      const [activeRun] = await tx.select({ id: runs.id }).from(runs).where(and(
        eq(runs.ownerUserId, sandbox.ownerUserId), eq(runs.projectId, sandbox.projectId),
        sql`${runs.status} in ('queued', 'planning', 'running', 'verifying')`,
      )).limit(1);
      const [activeProjectLock] = await tx.select({ projectId: projectRunLocks.projectId }).from(projectRunLocks).where(and(
        eq(projectRunLocks.ownerUserId, sandbox.ownerUserId), eq(projectRunLocks.projectId, sandbox.projectId),
        gt(projectRunLocks.leaseExpiresAt, now),
      )).limit(1);
      if (activeRun || activeProjectLock) continue;
      const lifecycleLeaseToken = randomUUID();
      const [updated] = await tx.update(sandboxes).set({
        status: sandbox.status === "ready" ? "ready" : "suspending",
        lifecycleLeaseToken,
        lifecycleLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      }).where(and(
        eq(sandboxes.id, sandbox.id), eq(sandboxes.status, sandbox.status),
        or(isNull(sandboxes.lifecycleLeaseExpiresAt), lte(sandboxes.lifecycleLeaseExpiresAt, now)),
      )).returning();
      if (updated) claimed.push({ ...updated, lifecycleLeaseToken } as SandboxRecord & { lifecycleLeaseToken: string });
    }
    return claimed;
  });
}

export async function beginSandboxSuspension(database: GameDatabase, input: {
  record: Pick<SandboxRecord, "id" | "ownerUserId" | "projectId">;
  leaseToken: string;
  snapshot: { id: string; sha256: string; sizeBytes: number } | null;
  maxStorageBytes: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(input.maxStorageBytes) || input.maxStorageBytes < 1) throw new RangeError("Invalid storage quota");
  return database.transaction(async (tx) => {
    const [owner] = await tx.select({ id: users.id }).from(users)
      .where(eq(users.id, input.record.ownerUserId)).for("update").limit(1);
    if (!owner) return false;
    const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
      eq(projects.ownerUserId, input.record.ownerUserId), eq(projects.id, input.record.projectId),
      isNull(projects.deletedAt), eq(projects.isInternal, false),
    )).for("update").limit(1);
    if (!project) return false;
    const [lockedSandbox] = await tx.select({ id: sandboxes.id }).from(sandboxes).where(and(
      eq(sandboxes.id, input.record.id), eq(sandboxes.ownerUserId, input.record.ownerUserId),
      eq(sandboxes.projectId, input.record.projectId), eq(sandboxes.status, "ready"),
      eq(sandboxes.lifecycleLeaseToken, input.leaseToken), gt(sandboxes.lifecycleLeaseExpiresAt, now),
    )).for("update").limit(1);
    if (!lockedSandbox) return false;
    if (input.snapshot) {
      const [assetUsage] = await tx.select({ bytes: sql<number>`coalesce(sum(${assets.sizeBytes}), 0)` }).from(assets)
        .where(eq(assets.ownerUserId, input.record.ownerUserId));
      const [versionUsage] = await tx.select({ bytes: sql<number>`coalesce(sum(${versions.sizeBytes}), 0)` }).from(versions)
        .where(eq(versions.ownerUserId, input.record.ownerUserId));
      const [reservationUsage] = await tx.select({ bytes: sql<number>`coalesce(sum(${usageReservations.reservedStorageBytes}), 0)` }).from(usageReservations)
        .where(and(eq(usageReservations.ownerUserId, input.record.ownerUserId), eq(usageReservations.status, "reserved")));
      const [lifecycleUsage] = await tx.select({ bytes: sql<number>`coalesce(sum(${sandboxes.lifecycleSnapshotSizeBytes}), 0)` }).from(sandboxes)
        .where(eq(sandboxes.ownerUserId, input.record.ownerUserId));
      const used = Number(assetUsage?.bytes ?? 0) + Number(versionUsage?.bytes ?? 0) +
        Number(reservationUsage?.bytes ?? 0) + Number(lifecycleUsage?.bytes ?? 0);
      if (used + input.snapshot.sizeBytes > input.maxStorageBytes) return false;
    }
    const [activeRun] = await tx.select({ id: runs.id }).from(runs).where(and(
      eq(runs.ownerUserId, input.record.ownerUserId), eq(runs.projectId, input.record.projectId),
      sql`${runs.status} in ('queued', 'planning', 'running', 'verifying')`,
    )).limit(1);
    if (activeRun) return false;
    const [activeProjectLock] = await tx.select({ projectId: projectRunLocks.projectId }).from(projectRunLocks).where(and(
      eq(projectRunLocks.ownerUserId, input.record.ownerUserId), eq(projectRunLocks.projectId, input.record.projectId),
      gt(projectRunLocks.leaseExpiresAt, now),
    )).limit(1);
    if (activeProjectLock) return false;
    const [updated] = await tx.update(sandboxes).set({
      status: "suspending",
      leaseExpiresAt: null,
      devServerStatus: "stopped",
      devServerPort: null,
      devServerLeaseExpiresAt: null,
      lifecycleSnapshotId: input.snapshot?.id ?? null,
      lifecycleSnapshotSha256: input.snapshot?.sha256 ?? null,
      lifecycleSnapshotSizeBytes: input.snapshot?.sizeBytes ?? null,
      updatedAt: now,
    }).where(and(
      eq(sandboxes.id, input.record.id), eq(sandboxes.ownerUserId, input.record.ownerUserId),
      eq(sandboxes.projectId, input.record.projectId), eq(sandboxes.status, "ready"),
      eq(sandboxes.lifecycleLeaseToken, input.leaseToken), gt(sandboxes.lifecycleLeaseExpiresAt, now),
    )).returning({ id: sandboxes.id });
    return Boolean(updated);
  });
}

export async function finishSandboxSuspension(database: GameDatabase, record: Pick<SandboxRecord, "id" | "ownerUserId" | "projectId">, leaseToken: string): Promise<boolean> {
  const [updated] = await database.update(sandboxes).set({
    status: "suspended", runtimeId: null, leaseExpiresAt: null,
    lifecycleLeaseToken: null, lifecycleLeaseExpiresAt: null, updatedAt: new Date(),
  }).where(and(
    eq(sandboxes.id, record.id), eq(sandboxes.ownerUserId, record.ownerUserId),
    eq(sandboxes.projectId, record.projectId), eq(sandboxes.status, "suspending"),
    eq(sandboxes.lifecycleLeaseToken, leaseToken),
  )).returning({ id: sandboxes.id });
  return Boolean(updated);
}

export async function releaseSandboxLifecycleLease(database: GameDatabase, record: Pick<SandboxRecord, "id" | "ownerUserId" | "projectId">, leaseToken: string, idleTtlSeconds: number): Promise<void> {
  const now = new Date();
  await database.update(sandboxes).set({
    lifecycleLeaseToken: null, lifecycleLeaseExpiresAt: null,
    ...(Number.isSafeInteger(idleTtlSeconds) && idleTtlSeconds > 0 ? { leaseExpiresAt: new Date(now.getTime() + idleTtlSeconds * 1000) } : {}),
    updatedAt: now,
  }).where(and(
    eq(sandboxes.id, record.id), eq(sandboxes.ownerUserId, record.ownerUserId),
    eq(sandboxes.projectId, record.projectId), eq(sandboxes.lifecycleLeaseToken, leaseToken),
    eq(sandboxes.status, "ready"),
  ));
}

export async function clearSandboxLifecycleSnapshot(database: GameDatabase, record: Pick<SandboxRecord, "id" | "ownerUserId" | "projectId">, snapshotId: string): Promise<boolean> {
  const [updated] = await database.update(sandboxes).set({
    lifecycleSnapshotId: null, lifecycleSnapshotSha256: null, lifecycleSnapshotSizeBytes: null,
    updatedAt: new Date(),
  }).where(and(
    eq(sandboxes.id, record.id), eq(sandboxes.ownerUserId, record.ownerUserId), eq(sandboxes.projectId, record.projectId),
    eq(sandboxes.lifecycleSnapshotId, snapshotId), eq(sandboxes.status, "ready"),
  )).returning({ id: sandboxes.id });
  return Boolean(updated);
}
