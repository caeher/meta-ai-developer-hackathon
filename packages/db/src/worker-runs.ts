import { and, asc, eq, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import type { GameDatabase } from "./database";
import {
  StaleRunWorkerError,
} from "./identity";
import { runChargeIdempotencyKey } from "./usage";
import {
  projectRunLocks,
  projects,
  runEvents,
  runOutbox,
  runs,
  usageLedger,
  usageReservations,
} from "./schema/index";

export type RunWorkerClaim = Readonly<{
  runId: string;
  ownerUserId: string;
  projectId: string;
  fencingToken: number;
}>;

export type RunUsage = Readonly<{ tokens: number; images: number }>;

const ACTIVE_STATUSES = ["planning", "running", "verifying"] as const;
const FINAL_STATUSES = ["succeeded", "failed", "cancelled"] as const;

async function appendRunEvent(
  tx: Parameters<Parameters<GameDatabase["transaction"]>[0]>[0],
  run: { id: string; ownerUserId: string; projectId: string },
  type: string,
  payload: Record<string, unknown>,
) {
  const [sequence] = await tx
    .select({ value: sql<number>`coalesce(max(${runEvents.sequence}), 0) + 1` })
    .from(runEvents)
    .where(and(eq(runEvents.ownerUserId, run.ownerUserId), eq(runEvents.runId, run.id)));
  await tx.insert(runEvents).values({
    ownerUserId: run.ownerUserId,
    projectId: run.projectId,
    runId: run.id,
    sequence: sequence?.value ?? 1,
    type,
    payload,
  });
}

export async function claimRun(
  database: GameDatabase,
  input: { runId: string; idempotencyKey: string; generation: number; leaseMs: number },
): Promise<{ claim: RunWorkerClaim; cancelRequested: boolean } | undefined> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 3_000 || input.leaseMs > 120_000) {
    throw new TypeError("run lease out of range");
  }
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
  return database.transaction(async (tx) => {
    const [candidate] = await tx.select({ ownerUserId: runs.ownerUserId, projectId: runs.projectId })
      .from(runs)
      .where(and(eq(runs.id, input.runId), eq(runs.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!candidate) return undefined;

    const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
      eq(projects.ownerUserId, candidate.ownerUserId),
      eq(projects.id, candidate.projectId),
      isNull(projects.deletedAt),
    )).for("update").limit(1);
    if (!project) return undefined;

    const [run] = await tx.select().from(runs).where(and(
      eq(runs.ownerUserId, candidate.ownerUserId),
      eq(runs.projectId, candidate.projectId),
      eq(runs.id, input.runId),
      eq(runs.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (!run || FINAL_STATUSES.includes(run.status as (typeof FINAL_STATUSES)[number])) return undefined;
    if (!(run.status === "queued" || ACTIVE_STATUSES.includes(run.status as (typeof ACTIVE_STATUSES)[number]))) return undefined;

    const [delivery] = await tx.select({ generation: runOutbox.generation }).from(runOutbox)
      .where(and(eq(runOutbox.runId, run.id), eq(runOutbox.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (!delivery || delivery.generation !== input.generation) return undefined;

    const [lock] = await tx.insert(projectRunLocks).values({
      ownerUserId: run.ownerUserId,
      projectId: run.projectId,
      runId: run.id,
      fencingToken: 1,
      leaseExpiresAt,
      heartbeatAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [projectRunLocks.ownerUserId, projectRunLocks.projectId],
      set: {
        runId: run.id,
        fencingToken: sql`${projectRunLocks.fencingToken} + 1`,
        leaseExpiresAt,
        heartbeatAt: now,
        updatedAt: now,
      },
      where: or(isNull(projectRunLocks.leaseExpiresAt), lte(projectRunLocks.leaseExpiresAt, now)),
    }).returning({ fencingToken: projectRunLocks.fencingToken });
    if (!lock) return undefined;

    const [updated] = await tx.update(runs).set({ status: "planning", errorCode: null, updatedAt: now })
      .where(eq(runs.id, run.id)).returning();
    if (!updated) throw new Error("No se pudo reclamar el run");
    await appendRunEvent(tx, updated, "run.claimed", { fencingToken: lock.fencingToken.toString() });
    return {
      claim: { runId: run.id, ownerUserId: run.ownerUserId, projectId: run.projectId, fencingToken: lock.fencingToken },
      cancelRequested: run.cancelRequestedAt !== null,
    };
  });
}

export async function renewRunLease(
  database: GameDatabase,
  claim: RunWorkerClaim,
  leaseMs: number,
): Promise<{ valid: boolean; cancelRequested: boolean }> {
  const now = new Date();
  const [lock] = await database.update(projectRunLocks).set({
    leaseExpiresAt: new Date(now.getTime() + leaseMs),
    heartbeatAt: now,
    updatedAt: now,
  }).where(and(
    eq(projectRunLocks.ownerUserId, claim.ownerUserId),
    eq(projectRunLocks.projectId, claim.projectId),
    eq(projectRunLocks.runId, claim.runId),
    eq(projectRunLocks.fencingToken, claim.fencingToken),
    sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
  )).returning({ runId: projectRunLocks.runId });
  if (!lock) return { valid: false, cancelRequested: false };
  const [run] = await database.select({ cancelRequestedAt: runs.cancelRequestedAt }).from(runs)
    .where(and(eq(runs.id, claim.runId), eq(runs.ownerUserId, claim.ownerUserId)))
    .limit(1);
  return { valid: true, cancelRequested: run?.cancelRequestedAt !== null && run?.cancelRequestedAt !== undefined };
}

export async function transitionClaimedRun(
  database: GameDatabase,
  claim: RunWorkerClaim,
  status: "running" | "verifying",
): Promise<void> {
  await database.transaction(async (tx) => {
    const now = new Date();
    const [lock] = await tx.select({ runId: projectRunLocks.runId }).from(projectRunLocks).where(and(
      eq(projectRunLocks.ownerUserId, claim.ownerUserId),
      eq(projectRunLocks.projectId, claim.projectId),
      eq(projectRunLocks.runId, claim.runId),
      eq(projectRunLocks.fencingToken, claim.fencingToken),
      sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
    )).for("update").limit(1);
    if (!lock) throw new StaleRunWorkerError();
    const [run] = await tx.update(runs).set({ status, updatedAt: now }).where(and(
      eq(runs.ownerUserId, claim.ownerUserId),
      eq(runs.projectId, claim.projectId),
      eq(runs.id, claim.runId),
      sql`${runs.status} in ('planning', 'running', 'verifying')`,
    )).returning();
    if (!run) throw new StaleRunWorkerError();
    await appendRunEvent(tx, run, `run.${status}`, { fencingToken: claim.fencingToken.toString() });
  });
}

export async function releaseRunForRetry(
  database: GameDatabase,
  claim: RunWorkerClaim,
  attempt: number,
): Promise<void> {
  await database.transaction(async (tx) => {
    const now = new Date();
    const [lock] = await tx.select({ runId: projectRunLocks.runId }).from(projectRunLocks).where(and(
      eq(projectRunLocks.ownerUserId, claim.ownerUserId),
      eq(projectRunLocks.projectId, claim.projectId),
      eq(projectRunLocks.runId, claim.runId),
      eq(projectRunLocks.fencingToken, claim.fencingToken),
      sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
    )).for("update").limit(1);
    if (!lock) throw new StaleRunWorkerError();
    const [run] = await tx.update(runs).set({ status: "queued", updatedAt: now }).where(and(
      eq(runs.ownerUserId, claim.ownerUserId),
      eq(runs.projectId, claim.projectId),
      eq(runs.id, claim.runId),
      sql`${runs.status} in ('planning', 'running', 'verifying')`,
    )).returning();
    if (!run) throw new StaleRunWorkerError();
    await tx.update(projectRunLocks).set({ runId: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now })
      .where(and(eq(projectRunLocks.ownerUserId, claim.ownerUserId), eq(projectRunLocks.projectId, claim.projectId), eq(projectRunLocks.fencingToken, claim.fencingToken)));
    await appendRunEvent(tx, run, "run.retry_scheduled", { attempt, fencingToken: claim.fencingToken.toString() });
  });
}

export async function finishClaimedRun(
  database: GameDatabase,
  claim: RunWorkerClaim,
  input: { status: "succeeded" | "failed" | "cancelled"; errorCode?: string | null; usage?: RunUsage },
) {
  const usage = input.usage ?? { tokens: 0, images: 0 };
  if (!Number.isSafeInteger(usage.tokens) || usage.tokens < 0 || !Number.isSafeInteger(usage.images) || usage.images < 0) {
    throw new TypeError("Measured run usage must be nonnegative integers");
  }
  return database.transaction(async (tx) => {
    const now = new Date();
    const [lock] = await tx.select({ runId: projectRunLocks.runId }).from(projectRunLocks).where(and(
      eq(projectRunLocks.ownerUserId, claim.ownerUserId),
      eq(projectRunLocks.projectId, claim.projectId),
      eq(projectRunLocks.runId, claim.runId),
      eq(projectRunLocks.fencingToken, claim.fencingToken),
      sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
    )).for("update").limit(1);
    if (!lock) throw new StaleRunWorkerError();

    const [run] = await tx.select().from(runs).where(and(
      eq(runs.ownerUserId, claim.ownerUserId),
      eq(runs.projectId, claim.projectId),
      eq(runs.id, claim.runId),
      sql`${runs.status} in ('planning', 'running', 'verifying')`,
    )).for("update").limit(1);
    if (!run) throw new StaleRunWorkerError();
    const [reservation] = await tx.select().from(usageReservations).where(and(
      eq(usageReservations.ownerUserId, claim.ownerUserId),
      eq(usageReservations.projectId, claim.projectId),
      eq(usageReservations.runId, claim.runId),
      eq(usageReservations.status, "reserved"),
    )).for("update").limit(1);
    if ((usage.tokens > 0 || usage.images > 0) && !reservation) throw new StaleRunWorkerError();
    const reservationExceeded = Boolean(reservation && (usage.tokens > reservation.reservedTokens || usage.images > reservation.reservedImages));
    const cancellationWon = input.status === "succeeded" && run.cancelRequestedAt !== null;
    const finalStatus = reservationExceeded ? "failed" : cancellationWon ? "cancelled" : input.status;
    const finalErrorCode = reservationExceeded ? "usage_reservation_exceeded" : cancellationWon ? null : input.errorCode ?? null;

    if (reservation && (usage.tokens > 0 || usage.images > 0)) {
      const idempotencyKey = runChargeIdempotencyKey(run.id);
      const [charge] = await tx.insert(usageLedger).values({
        ownerUserId: claim.ownerUserId,
        projectId: claim.projectId,
        reservationId: reservation.id,
        idempotencyKey,
        kind: "charge",
        tokens: usage.tokens,
        images: usage.images,
        metadata: { fencingToken: claim.fencingToken.toString(), runId: claim.runId },
      }).onConflictDoNothing({ target: [usageLedger.ownerUserId, usageLedger.idempotencyKey] }).returning();
      if (!charge) {
        const [existing] = await tx.select().from(usageLedger).where(and(
          eq(usageLedger.ownerUserId, claim.ownerUserId),
          eq(usageLedger.idempotencyKey, idempotencyKey),
        )).limit(1);
        if (!existing || existing.reservationId !== reservation.id || existing.tokens !== usage.tokens || existing.images !== usage.images) {
          throw new Error("No se pudo reconciliar el cargo idempotente del run");
        }
      }
    }
    if (reservation) {
      await tx.update(usageReservations).set({
        status: finalStatus === "succeeded" || usage.tokens > 0 || usage.images > 0 ? "committed" : "released",
        updatedAt: now,
      }).where(and(eq(usageReservations.id, reservation.id), eq(usageReservations.status, "reserved")));
    }

    const [updated] = await tx.update(runs).set({
      status: finalStatus,
      errorCode: finalErrorCode,
      updatedAt: now,
    }).where(and(eq(runs.ownerUserId, claim.ownerUserId), eq(runs.id, claim.runId))).returning();
    if (!updated) throw new StaleRunWorkerError();
    await tx.update(projectRunLocks).set({ runId: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now })
      .where(and(eq(projectRunLocks.ownerUserId, claim.ownerUserId), eq(projectRunLocks.projectId, claim.projectId), eq(projectRunLocks.fencingToken, claim.fencingToken)));
    await appendRunEvent(tx, updated, `run.${updated.status}`, {
      ...(updated.errorCode ? { errorCode: updated.errorCode } : {}),
      usage,
      ...(reservationExceeded ? { reservationExceeded: true } : {}),
      ...(cancellationWon ? { cancelRequested: true } : {}),
      fencingToken: claim.fencingToken.toString(),
    });
    return updated;
  });
}

export async function reconcileExpiredRunLeases(database: GameDatabase, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("reconciliation limit out of range");
  const now = new Date();
  return database.transaction(async (tx) => {
    const expiredLocks = await tx.select().from(projectRunLocks)
      .where(and(isNotNull(projectRunLocks.runId), lte(projectRunLocks.leaseExpiresAt, now)))
      .orderBy(asc(projectRunLocks.leaseExpiresAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    let reconciled = 0;
    for (const lock of expiredLocks) {
      if (!lock.runId) continue;
      const [run] = await tx.select().from(runs).where(and(
        eq(runs.ownerUserId, lock.ownerUserId),
        eq(runs.projectId, lock.projectId),
        eq(runs.id, lock.runId),
      )).for("update").limit(1);
      if (!run || FINAL_STATUSES.includes(run.status as (typeof FINAL_STATUSES)[number])) {
        await tx.update(projectRunLocks).set({ runId: null, leaseExpiresAt: null, updatedAt: now })
          .where(and(eq(projectRunLocks.ownerUserId, lock.ownerUserId), eq(projectRunLocks.projectId, lock.projectId), eq(projectRunLocks.fencingToken, lock.fencingToken)));
        continue;
      }

      if (run.cancelRequestedAt) {
        await tx.update(runs).set({ status: "cancelled", errorCode: null, updatedAt: now }).where(eq(runs.id, run.id));
        await tx.update(usageReservations).set({ status: "released", updatedAt: now }).where(and(eq(usageReservations.runId, run.id), eq(usageReservations.status, "reserved")));
        await appendRunEvent(tx, run, "run.cancelled", { reason: "cancel_requested", fencingToken: lock.fencingToken.toString() });
      } else {
        await tx.update(runs).set({ status: "queued", errorCode: null, updatedAt: now }).where(eq(runs.id, run.id));
        await tx.update(runOutbox).set({
          status: "pending",
          generation: sql`${runOutbox.generation} + 1`,
          leaseToken: null,
          leaseExpiresAt: null,
          dispatchedAt: null,
          lastErrorCode: "worker_lease_expired",
          updatedAt: now,
        }).where(eq(runOutbox.runId, run.id));
        await appendRunEvent(tx, run, "run.requeued", { reason: "lease_expired", fencingToken: lock.fencingToken.toString() });
      }
      await tx.update(projectRunLocks).set({ runId: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now })
        .where(and(eq(projectRunLocks.ownerUserId, lock.ownerUserId), eq(projectRunLocks.projectId, lock.projectId), eq(projectRunLocks.fencingToken, lock.fencingToken)));
      reconciled += 1;
    }
    return reconciled;
  });
}
