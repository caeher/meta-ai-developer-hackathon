import { and, asc, desc, eq, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import type { GameDatabase } from "./database";
import {
  UsageLimitExceededError,
  StaleRunWorkerError,
  identityFromAuthenticatedSession,
  type VerifiedIdentityContext,
} from "./identity";
import { AgentRunEventSchema, type AgentRunEvent, type MetaPlan } from "@meta-game/contracts";
import { runChargeIdempotencyKey } from "./usage";
import {
  projectRunLocks,
  messages,
  projects,
  runEvents,
  runOutbox,
  runs,
  usageLedger,
  usageReservations,
  users,
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

export type ClaimedRunAgentEvent = Readonly<{
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}>;

export type ClaimedRunAgentContext = Readonly<{
  prompt: string;
  plan: unknown | null;
  events: ClaimedRunAgentEvent[];
  priorGameSpec?: unknown | null;
}>;

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

async function currentClaimedRun(
  tx: Parameters<Parameters<GameDatabase["transaction"]>[0]>[0],
  claim: RunWorkerClaim,
) {
  const now = new Date();
  const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
    eq(projects.ownerUserId, claim.ownerUserId),
    eq(projects.id, claim.projectId),
    isNull(projects.deletedAt),
  )).for("update").limit(1);
  if (!project) throw new StaleRunWorkerError();

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
  return run;
}

async function appendAgentEventTx(
  tx: Parameters<Parameters<GameDatabase["transaction"]>[0]>[0],
  claim: RunWorkerClaim,
  event: AgentRunEvent,
): Promise<void> {
  const [sequence] = await tx.select({ value: sql<number>`coalesce(max(${runEvents.sequence}), 0) + 1` })
    .from(runEvents)
    .where(and(eq(runEvents.ownerUserId, claim.ownerUserId), eq(runEvents.runId, claim.runId)));
  await tx.insert(runEvents).values({
    ownerUserId: claim.ownerUserId,
    projectId: claim.projectId,
    runId: claim.runId,
    sequence: sequence?.value ?? 1,
    type: event.type,
    payload: event.payload,
  });
}

export async function getClaimedRunAgentContext(
  database: GameDatabase,
  claim: RunWorkerClaim,
): Promise<ClaimedRunAgentContext> {
  return database.transaction(async (tx) => {
    const run = await currentClaimedRun(tx, claim);
    if (!run.contributorConsent) throw new Error("run_contributor_consent_missing");
    const [message] = await tx.select({ content: messages.content }).from(messages).where(and(
      eq(messages.ownerUserId, claim.ownerUserId),
      eq(messages.projectId, claim.projectId),
      eq(messages.runId, claim.runId),
      eq(messages.role, "user"),
    )).orderBy(asc(messages.sequence)).limit(1);
    const events = await tx.select({ sequence: runEvents.sequence, type: runEvents.type, payload: runEvents.payload })
      .from(runEvents)
      .where(and(eq(runEvents.ownerUserId, claim.ownerUserId), eq(runEvents.runId, claim.runId), sql`${runEvents.type} like 'agent.%'`))
      .orderBy(asc(runEvents.sequence))
      .limit(5_000);
    const [priorSpec] = await tx.select({ payload: runEvents.payload })
      .from(runEvents)
      .innerJoin(runs, and(eq(runs.id, runEvents.runId), eq(runs.ownerUserId, runEvents.ownerUserId), eq(runs.projectId, runEvents.projectId)))
      .where(and(
        eq(runEvents.ownerUserId, claim.ownerUserId),
        eq(runEvents.projectId, claim.projectId),
        eq(runEvents.type, "agent.game_spec"),
        sql`${runs.id} <> ${claim.runId}`,
        eq(runs.status, "succeeded"),
      ))
      .orderBy(desc(runs.updatedAt), desc(runEvents.sequence))
      .limit(1);
    if (!message) {
      throw new Error("run_user_message_missing");
    }
    const priorPayload = priorSpec?.payload as Record<string, unknown> | undefined;
    const priorGameSpec = priorPayload && typeof priorPayload === "object" ? priorPayload.spec : null;
    return { prompt: message.content, plan: run.plan, events, priorGameSpec };
  });
}

/** Resolves the storage identity only while the supplied worker fencing claim is current. */
export async function getClaimedRunIdentity(
  database: GameDatabase,
  claim: RunWorkerClaim,
): Promise<VerifiedIdentityContext> {
  return database.transaction(async (tx) => {
    const run = await currentClaimedRun(tx, claim);
    const [user] = await tx.select({ userId: users.userId }).from(users)
      .where(eq(users.id, run.ownerUserId)).limit(1);
    if (!user) throw new StaleRunWorkerError();
    return identityFromAuthenticatedSession({ userId: user.userId });
  });
}

export async function reserveClaimedRunImage(
  database: GameDatabase,
  claim: RunWorkerClaim,
  input: { requestKey: string; round: number; dailyImageLimit: number },
): Promise<boolean> {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(input.requestKey) || !Number.isSafeInteger(input.round) || input.round < 0 ||
      !Number.isSafeInteger(input.dailyImageLimit) || input.dailyImageLimit < 1 || input.dailyImageLimit > 100_000) {
    throw new TypeError("Invalid image usage reservation");
  }
  return database.transaction(async (tx) => {
    const run = await currentClaimedRun(tx, claim);
    const [existingRequest] = await tx.select({ payload: runEvents.payload }).from(runEvents).where(and(
      eq(runEvents.ownerUserId, claim.ownerUserId),
      eq(runEvents.runId, claim.runId),
      eq(runEvents.type, "agent.meta_request_started"),
      sql`${runEvents.payload}->>'requestKey' = ${input.requestKey}`,
    )).limit(1);
    if (existingRequest) {
      const payload = existingRequest.payload as Record<string, unknown>;
      if (payload.kind !== "image" || payload.round !== input.round) throw new Error("run_image_request_key_conflict");
      return false;
    }
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, run.ownerUserId)).for("update").limit(1);
    if (!user) throw new StaleRunWorkerError();
    const [reservation] = await tx.select().from(usageReservations).where(and(
      eq(usageReservations.ownerUserId, claim.ownerUserId),
      eq(usageReservations.projectId, claim.projectId),
      eq(usageReservations.runId, claim.runId),
      eq(usageReservations.status, "reserved"),
    )).for("update").limit(1);
    if (!reservation) throw new StaleRunWorkerError();

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [consumed] = await tx.select({
      images: sql<number>`coalesce(sum(case when ${usageLedger.kind} = 'refund' then -${usageLedger.images} else ${usageLedger.images} end), 0)`,
    }).from(usageLedger).where(and(
      eq(usageLedger.ownerUserId, claim.ownerUserId),
      sql`${usageLedger.createdAt} >= ${dayStart}`,
    ));
    const [held] = await tx.select({
      images: sql<number>`coalesce(sum(${usageReservations.reservedImages}), 0)`,
    }).from(usageReservations).where(and(
      eq(usageReservations.ownerUserId, claim.ownerUserId),
      eq(usageReservations.status, "reserved"),
    ));
    if (Number(consumed?.images ?? 0) + Number(held?.images ?? 0) >= input.dailyImageLimit) {
      throw new UsageLimitExceededError("images");
    }
    await tx.update(usageReservations).set({
      reservedImages: reservation.reservedImages + 1,
      updatedAt: new Date(),
    }).where(and(eq(usageReservations.id, reservation.id), eq(usageReservations.status, "reserved")));
    await appendAgentEventTx(tx, claim, {
      type: "agent.meta_request_started",
      payload: { kind: "image", requestKey: input.requestKey, round: input.round },
    });
    return true;
  });
}

export async function appendClaimedRunAgentEvents(
  database: GameDatabase,
  claim: RunWorkerClaim,
  events: readonly AgentRunEvent[],
): Promise<void> {
  const parsed = events.map((event) => AgentRunEventSchema.parse(event));
  await database.transaction(async (tx) => {
    await currentClaimedRun(tx, claim);
    for (const event of parsed) await appendAgentEventTx(tx, claim, event);
  });
}

export async function persistClaimedRunPlan(
  database: GameDatabase,
  claim: RunWorkerClaim,
  input: {
    plan: MetaPlan;
    model: string;
    responseId: string;
    requestId?: string;
    usage: { tokens: number; images: 0 };
  },
): Promise<void> {
  const plan = AgentRunEventSchema.parse({
    type: "agent.plan",
    payload: {
      plan: input.plan,
      model: input.model,
      responseId: input.responseId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      usage: input.usage,
    },
  });
  await database.transaction(async (tx) => {
    const run = await currentClaimedRun(tx, claim);
    if (run.plan !== null) {
      if (JSON.stringify(run.plan) !== JSON.stringify(input.plan)) throw new StaleRunWorkerError();
      return;
    }
    await tx.update(runs).set({ plan: input.plan, updatedAt: new Date() }).where(and(
      eq(runs.ownerUserId, claim.ownerUserId), eq(runs.projectId, claim.projectId), eq(runs.id, claim.runId), isNull(runs.plan),
    ));
    await appendAgentEventTx(tx, claim, {
      type: "agent.meta_response_completed",
      payload: {
        kind: "plan",
        requestKey: "plan",
        responseId: input.responseId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        model: input.model,
        usage: input.usage,
      },
    });
    await appendAgentEventTx(tx, claim, plan);
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
    const [completion] = await tx.select({ payload: runEvents.payload }).from(runEvents).where(and(
      eq(runEvents.ownerUserId, claim.ownerUserId),
      eq(runEvents.runId, claim.runId),
      eq(runEvents.type, "agent.completed"),
    )).orderBy(desc(runEvents.sequence)).limit(1);
    const completionSummary = completion?.payload && typeof completion.payload === "object" && !Array.isArray(completion.payload)
      ? (completion.payload as Record<string, unknown>).summary
      : undefined;
    await tx.update(projectRunLocks).set({ runId: null, leaseExpiresAt: null, heartbeatAt: now, updatedAt: now })
      .where(and(eq(projectRunLocks.ownerUserId, claim.ownerUserId), eq(projectRunLocks.projectId, claim.projectId), eq(projectRunLocks.fencingToken, claim.fencingToken)));
    await appendRunEvent(tx, updated, `run.${updated.status}`, {
      ...(updated.status === "succeeded" && typeof completionSummary === "string" ? { summary: completionSummary.slice(0, 600) } : {}),
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
