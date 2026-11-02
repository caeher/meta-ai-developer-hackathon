import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { GameDatabase } from "./database";
import { projectRunLocks, projects, runOutbox, runs } from "./schema/index";

export type ClaimedRunOutbox = Pick<
  typeof runOutbox.$inferSelect,
  "id" | "runId" | "idempotencyKey" | "generation" | "leaseToken"
>;

export async function claimRunOutboxBatch(
  database: GameDatabase,
  input: { limit?: number; leaseMs?: number } = {},
): Promise<ClaimedRunOutbox[]> {
  const limit = input.limit ?? 25;
  const leaseMs = input.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("outbox limit out of range");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 120_000) throw new TypeError("outbox lease out of range");
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  return database.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(runOutbox)
      .where(or(
        eq(runOutbox.status, "pending"),
        and(eq(runOutbox.status, "dispatching"), lte(runOutbox.leaseExpiresAt, now)),
      ))
      .orderBy(asc(runOutbox.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    const claimed: ClaimedRunOutbox[] = [];
    for (const row of rows) {
      const leaseToken = randomUUID();
      const [updated] = await tx
        .update(runOutbox)
        .set({
          status: "dispatching",
          leaseToken,
          leaseExpiresAt,
          attempts: sql`${runOutbox.attempts} + 1`,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(and(eq(runOutbox.id, row.id), eq(runOutbox.generation, row.generation)))
        .returning({ id: runOutbox.id, runId: runOutbox.runId, idempotencyKey: runOutbox.idempotencyKey, generation: runOutbox.generation, leaseToken: runOutbox.leaseToken });
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function markRunOutboxDispatched(
  database: GameDatabase,
  item: ClaimedRunOutbox,
): Promise<boolean> {
  const [updated] = await database
    .update(runOutbox)
    .set({ status: "dispatched", dispatchedAt: new Date(), leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(
      eq(runOutbox.id, item.id),
      eq(runOutbox.generation, item.generation),
      eq(runOutbox.status, "dispatching"),
      eq(runOutbox.leaseToken, item.leaseToken!),
    ))
    .returning({ id: runOutbox.id });
  return Boolean(updated);
}

export async function markRunOutboxRetryable(
  database: GameDatabase,
  item: ClaimedRunOutbox,
  code: string,
): Promise<void> {
  await database
    .update(runOutbox)
    .set({ status: "pending", leaseToken: null, leaseExpiresAt: null, lastErrorCode: code.slice(0, 100), updatedAt: new Date() })
    .where(and(
      eq(runOutbox.id, item.id),
      eq(runOutbox.generation, item.generation),
      eq(runOutbox.status, "dispatching"),
      eq(runOutbox.leaseToken, item.leaseToken!),
    ));
}

export async function listDispatchedQueuedRuns(database: GameDatabase, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("reconciliation limit out of range");
  return database
    .select({ runId: runs.id, generation: runOutbox.generation, idempotencyKey: runOutbox.idempotencyKey })
    .from(runOutbox)
    .innerJoin(runs, and(eq(runs.ownerUserId, runOutbox.ownerUserId), eq(runs.projectId, runOutbox.projectId), eq(runs.id, runOutbox.runId)))
    .innerJoin(projects, and(eq(projects.ownerUserId, runs.ownerUserId), eq(projects.id, runs.projectId)))
    .where(and(eq(runOutbox.status, "dispatched"), eq(runs.status, "queued"), sql`${projects.deletedAt} is null`))
    .orderBy(asc(runOutbox.createdAt))
    .limit(limit);
}

export async function reopenMissingQueuedRunOutbox(
  database: GameDatabase,
  input: { runId: string; generation: number },
): Promise<number | undefined> {
  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ ownerUserId: runs.ownerUserId, projectId: runs.projectId })
      .from(runs)
      .innerJoin(runOutbox, and(eq(runOutbox.ownerUserId, runs.ownerUserId), eq(runOutbox.projectId, runs.projectId), eq(runOutbox.runId, runs.id)))
      .where(and(eq(runs.id, input.runId), eq(runs.status, "queued"), eq(runOutbox.generation, input.generation), eq(runOutbox.status, "dispatched")))
      .limit(1);
    if (!candidate) return undefined;
    const [lock] = await tx
      .select({ runId: projectRunLocks.runId, leaseExpiresAt: projectRunLocks.leaseExpiresAt })
      .from(projectRunLocks)
      .where(and(eq(projectRunLocks.ownerUserId, candidate.ownerUserId), eq(projectRunLocks.projectId, candidate.projectId)))
      .for("update")
      .limit(1);
    if (lock?.runId && lock.leaseExpiresAt && lock.leaseExpiresAt > new Date()) return undefined;
    const [updated] = await tx
      .update(runOutbox)
      .set({ status: "pending", generation: sql`${runOutbox.generation} + 1`, dispatchedAt: null, leaseToken: null, leaseExpiresAt: null, lastErrorCode: "redis_job_missing", updatedAt: new Date() })
      .where(and(eq(runOutbox.runId, input.runId), eq(runOutbox.generation, input.generation), eq(runOutbox.status, "dispatched")))
      .returning({ generation: runOutbox.generation });
    return updated?.generation;
  });
}
