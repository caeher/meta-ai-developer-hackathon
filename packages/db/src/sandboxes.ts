import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { GameDatabase } from "./database";
import { projects, sandboxes } from "./schema/index";

export type SandboxState = "provisioning" | "ready" | "stopping" | "stopped" | "failed";
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
      if (existing.status === "stopping") throw new SandboxOperationConflictError();
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
  },
): Promise<void> {
  const [updated] = await database.update(sandboxes).set({
    status: patch.status,
    ...(patch.runtimeId !== undefined ? { runtimeId: patch.runtimeId } : {}),
    ...(patch.leaseExpiresAt !== undefined ? { leaseExpiresAt: patch.leaseExpiresAt } : {}),
    ...(patch.devServerStatus !== undefined ? { devServerStatus: patch.devServerStatus } : {}),
    ...(patch.devServerPort !== undefined ? { devServerPort: patch.devServerPort } : {}),
    ...(patch.devServerLeaseExpiresAt !== undefined ? { devServerLeaseExpiresAt: patch.devServerLeaseExpiresAt } : {}),
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
    const expired = await tx.select().from(sandboxes).where(or(
      and(inArray(sandboxes.status, ["ready", "stopped", "failed"]), or(
        isNull(sandboxes.leaseExpiresAt), lte(sandboxes.leaseExpiresAt, now),
      )),
      and(eq(sandboxes.status, "stopping"), lte(sandboxes.updatedAt, staleStoppingCutoff)),
    )).orderBy(sandboxes.updatedAt).limit(limit).for("update", { skipLocked: true });
    const claimed: SandboxRecord[] = [];
    for (const record of expired) {
      const currentCondition = record.status === "ready"
        ? and(eq(sandboxes.status, "ready"), or(isNull(sandboxes.leaseExpiresAt), lte(sandboxes.leaseExpiresAt, now)))
        : record.status === "stopping"
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
