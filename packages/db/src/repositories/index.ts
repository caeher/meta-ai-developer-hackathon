import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { GameDatabase } from "../database";
import {
  assertVerifiedIdentityContext,
  IdempotencyConflictError,
  OwnedResourceNotFoundError,
  ProjectRunBusyError,
  type VerifiedIdentityContext,
} from "../identity";
import { assertRunQuotaAvailable, RunQuotaPolicySchema, utcDayStart, type RunQuotaPolicy } from "../usage";
import {
  assets,
  messages,
  projects,
  publications,
  projectCleanupTasks,
  runEvents,
  runOutbox,
  runs,
  sandboxes,
  usageLedger,
  usageReservations,
  users,
  versions,
} from "../schema/index";

const uuidSchema = z.string().uuid();
const projectNameSchema = z.string().trim().min(1).max(120);
const pageInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
const pageCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: uuidSchema,
});
const messageCursorSchema = z.object({ sequence: z.number().int().positive() });
const listEventInputSchema = z.object({
  afterSequence: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
});
const assetInputSchema = z.object({
  projectId: uuidSchema,
  contentType: z.string().trim().min(1).max(150),
  sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const versionInputSchema = z.object({
  projectId: uuidSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const usageInputSchema = z.object({
  projectId: uuidSchema,
  idempotencyKey: z.string().min(8).max(128),
  reservedTokens: z.number().int().nonnegative().max(2_000_000).default(0),
  reservedImages: z.number().int().nonnegative().max(100_000).default(0),
  reservedStorageBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  expiresAt: z.date(),
});
const ledgerInputSchema = z.object({
  reservationId: uuidSchema,
  idempotencyKey: z.string().min(8).max(128),
  kind: z.enum(["charge", "refund", "adjustment"]),
  tokens: z.number().int().nonnegative().default(0),
  images: z.number().int().nonnegative().default(0),
  storageBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const messageInputSchema = z.object({
  projectId: uuidSchema,
  requestId: z.string().trim().min(8).max(128),
  runId: uuidSchema.optional(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().min(1).max(100_000),
});
const runInputSchema = z.object({
  projectId: uuidSchema,
  idempotencyKey: z.string().min(8).max(128),
});
const enqueueRunInputSchema = z.object({
  projectId: uuidSchema,
  idempotencyKey: z.string().min(8).max(128),
  reservedImages: z.number().int().nonnegative().max(100_000).default(0),
  policy: RunQuotaPolicySchema,
});
const runEventInputSchema = z.object({
  type: z.string().trim().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
});

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function encodeCursor(value: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: value.createdAt.toISOString(), id: value.id })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const parsed = pageCursorSchema.parse(decoded);
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw new TypeError("Cursor de paginación inválido");
  }
}

function makePage<T extends { createdAt: Date; id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

function requireContext(identity: VerifiedIdentityContext) {
  assertVerifiedIdentityContext(identity);
  return identity.clerkUserId;
}

async function resolveOwnerId(db: GameDatabase, identity: VerifiedIdentityContext): Promise<string> {
  const clerkUserId = requireContext(identity);
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);
  if (!owner) throw new OwnedResourceNotFoundError();
  return owner.id;
}

async function assertOwnedProject(
  db: GameDatabase,
  ownerUserId: string,
  projectId: string,
): Promise<void> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (!project) throw new OwnedResourceNotFoundError();
}

export function createRepositories(db: GameDatabase) {
  return {
    projects: {
      async create(identity: VerifiedIdentityContext, input: { name: string }) {
        const clerkUserId = requireContext(identity);
        const name = projectNameSchema.parse(input.name);
        const [owner] = await db
          .insert(users)
          .values({ clerkUserId })
          .onConflictDoUpdate({
            target: users.clerkUserId,
            set: { updatedAt: new Date() },
          })
          .returning({ id: users.id });
        if (!owner) throw new Error("No se pudo resolver el dueño del proyecto");
        const [project] = await db
          .insert(projects)
          .values({ ownerUserId: owner.id, name })
          .returning();
        if (!project) throw new Error("No se pudo crear el proyecto");
        return project;
      },

      async get(identity: VerifiedIdentityContext, projectId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        const [project] = await db
          .select()
          .from(projects)
          .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsedProjectId), isNull(projects.deletedAt)))
          .limit(1);
        return project;
      },

      async rename(identity: VerifiedIdentityContext, projectId: string, name: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        const [project] = await db
          .update(projects)
          .set({ name: projectNameSchema.parse(name), updatedAt: new Date() })
          .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsedProjectId), isNull(projects.deletedAt)))
          .returning();
        if (!project) throw new OwnedResourceNotFoundError();
        return project;
      },

      async list(identity: VerifiedIdentityContext, input: { limit?: number; cursor?: string } = {}) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const { limit, cursor: rawCursor } = pageInputSchema.parse(input);
        const cursor = decodeCursor(rawCursor);
        const where = cursor
          ? and(
              eq(projects.ownerUserId, ownerUserId),
              isNull(projects.deletedAt),
              or(
                lt(projects.createdAt, cursor.createdAt),
                and(eq(projects.createdAt, cursor.createdAt), lt(projects.id, cursor.id)),
              ),
            )
          : and(eq(projects.ownerUserId, ownerUserId), isNull(projects.deletedAt));
        const rows = await db
          .select()
          .from(projects)
          .where(where)
          .orderBy(desc(projects.createdAt), desc(projects.id))
          .limit(limit + 1);
        return makePage(rows, limit);
      },

      async delete(identity: VerifiedIdentityContext, projectId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        return db.transaction(async (tx) => {
          const [project] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(and(
              eq(projects.ownerUserId, ownerUserId),
              eq(projects.id, parsedProjectId),
              isNull(projects.deletedAt),
            ))
            .for("update")
            .limit(1);
          if (!project) throw new OwnedResourceNotFoundError();

          const deletedAt = new Date();
          await tx.update(projects)
            .set({ deletedAt, updatedAt: deletedAt })
            .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsedProjectId)));
          await tx.update(runs)
            .set({ status: "cancelled", errorCode: "project_deleted", updatedAt: deletedAt })
            .where(and(
              eq(runs.ownerUserId, ownerUserId),
              eq(runs.projectId, parsedProjectId),
              inArray(runs.status, ["queued", "planning", "running", "verifying"]),
            ));
          await tx.update(sandboxes)
            .set({ status: "stopping", updatedAt: deletedAt })
            .where(and(eq(sandboxes.ownerUserId, ownerUserId), eq(sandboxes.projectId, parsedProjectId)));
          await tx.update(assets)
            .set({ status: "delete_requested", updatedAt: deletedAt })
            .where(and(eq(assets.ownerUserId, ownerUserId), eq(assets.projectId, parsedProjectId)));
          await tx.update(versions)
            .set({ status: "delete_requested" })
            .where(and(eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, parsedProjectId)));
          await tx.update(publications)
            .set({ status: "revoked", updatedAt: deletedAt })
            .where(and(eq(publications.ownerUserId, ownerUserId), eq(publications.projectId, parsedProjectId)));
          await tx.update(usageReservations)
            .set({ status: "released", updatedAt: deletedAt })
            .where(and(
              eq(usageReservations.ownerUserId, ownerUserId),
              eq(usageReservations.projectId, parsedProjectId),
              eq(usageReservations.status, "reserved"),
            ));
          const [task] = await tx.insert(projectCleanupTasks)
            .values({ ownerUserId, projectId: parsedProjectId })
            .returning({ id: projectCleanupTasks.id, status: projectCleanupTasks.status });
          if (!task) throw new Error("No se pudo encolar la limpieza del proyecto");
          return { id: parsedProjectId, deletedAt, cleanup: task };
        });
      },
    },

    messages: {
      async create(identity: VerifiedIdentityContext, input: z.input<typeof messageInputSchema>) {
        const parsed = messageInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        return db.transaction(async (tx) => {
          const [project] = await tx.select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), isNull(projects.deletedAt)))
            .for("update")
            .limit(1);
          if (!project) throw new OwnedResourceNotFoundError();

          const [existing] = await tx.select().from(messages).where(and(
            eq(messages.ownerUserId, ownerUserId),
            eq(messages.projectId, parsed.projectId),
            eq(messages.requestId, parsed.requestId),
          )).limit(1);
          if (existing) {
            if (existing.role !== parsed.role || existing.content !== parsed.content || existing.runId !== (parsed.runId ?? null)) {
              throw new IdempotencyConflictError();
            }
            return existing;
          }
          if (parsed.runId) {
            const [run] = await tx.select({ id: runs.id }).from(runs).where(and(
              eq(runs.ownerUserId, ownerUserId),
              eq(runs.projectId, parsed.projectId),
              eq(runs.id, parsed.runId),
            )).limit(1);
            if (!run) throw new OwnedResourceNotFoundError();
          }
          const [sequence] = await tx.select({ value: sql<number>`coalesce(max(${messages.sequence}), 0) + 1` })
            .from(messages)
            .where(and(eq(messages.ownerUserId, ownerUserId), eq(messages.projectId, parsed.projectId)));
          const [message] = await tx.insert(messages)
            .values({ ...parsed, sequence: sequence?.value ?? 1, ownerUserId, runId: parsed.runId ?? null })
            .returning();
          if (!message) throw new Error("No se pudo crear el mensaje");
          return message;
        });
      },

      async list(
        identity: VerifiedIdentityContext,
        projectId: string,
        input: { limit?: number; cursor?: string } = {},
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        await assertOwnedProject(db, ownerUserId, parsedProjectId);
        const { limit, cursor: rawCursor } = pageInputSchema.parse(input);
        let cursor: z.infer<typeof messageCursorSchema> | undefined;
        if (rawCursor) {
          try {
            cursor = messageCursorSchema.parse(JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")));
          } catch {
            throw new TypeError("Cursor de mensajes inválido");
          }
        }
        const where = cursor
          ? and(
              eq(messages.ownerUserId, ownerUserId),
              eq(messages.projectId, parsedProjectId),
              lt(messages.sequence, cursor.sequence),
            )
          : and(eq(messages.ownerUserId, ownerUserId), eq(messages.projectId, parsedProjectId));
        const rows = await db
          .select()
          .from(messages)
          .where(where)
          .orderBy(desc(messages.sequence))
          .limit(limit + 1);
        const items = rows.slice(0, limit);
        const last = items.at(-1);
        return {
          items: items.reverse(),
          nextCursor: rows.length > limit && last
            ? Buffer.from(JSON.stringify({ sequence: last.sequence })).toString("base64url")
            : null,
        };
      },
    },

    runs: {
      async enqueueRun(identity: VerifiedIdentityContext, input: z.input<typeof enqueueRunInputSchema>) {
        const parsed = enqueueRunInputSchema.parse(input);
        const policy: RunQuotaPolicy = RunQuotaPolicySchema.parse(parsed.policy);
        const ownerUserId = await resolveOwnerId(db, identity);
        return db.transaction(async (tx) => {
          const [owner] = await tx.select({ id: users.id }).from(users)
            .where(eq(users.id, ownerUserId)).for("update").limit(1);
          if (!owner) throw new OwnedResourceNotFoundError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId),
            eq(projects.id, parsed.projectId),
            isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();

          const [existing] = await tx.select().from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId),
            eq(runs.idempotencyKey, parsed.idempotencyKey),
          )).limit(1);
          if (existing) {
            if (existing.projectId !== parsed.projectId) throw new IdempotencyConflictError();
            return { run: existing, created: false };
          }

          const [projectActive] = await tx.select({ count: sql<number>`count(*)` }).from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId),
            eq(runs.projectId, parsed.projectId),
            sql`${runs.status} in ('queued', 'planning', 'running', 'verifying')`,
          ));
          if (Number(projectActive?.count ?? 0) > 0) throw new ProjectRunBusyError();

          const [activeRuns] = await tx.select({ count: sql<number>`count(*)` }).from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId),
            sql`${runs.status} in ('queued', 'planning', 'running', 'verifying')`,
          ));
          const dayStart = utcDayStart(new Date());
          const [consumed] = await tx.select({
            tokens: sql<number>`coalesce(sum(case when ${usageLedger.kind} = 'refund' then -${usageLedger.tokens} else ${usageLedger.tokens} end), 0)`,
            images: sql<number>`coalesce(sum(case when ${usageLedger.kind} = 'refund' then -${usageLedger.images} else ${usageLedger.images} end), 0)`,
          }).from(usageLedger).where(and(
            eq(usageLedger.ownerUserId, ownerUserId),
            sql`${usageLedger.createdAt} >= ${dayStart}`,
          ));
          const [held] = await tx.select({
            tokens: sql<number>`coalesce(sum(${usageReservations.reservedTokens}), 0)`,
            images: sql<number>`coalesce(sum(${usageReservations.reservedImages}), 0)`,
          }).from(usageReservations).where(and(
            eq(usageReservations.ownerUserId, ownerUserId),
            eq(usageReservations.status, "reserved"),
          ));
          assertRunQuotaAvailable({
            activeRuns: Number(activeRuns?.count ?? 0),
            heldTokens: Number(held?.tokens ?? 0),
            heldImages: Number(held?.images ?? 0),
            consumedTokensToday: Number(consumed?.tokens ?? 0),
            consumedImagesToday: Number(consumed?.images ?? 0),
            reserveTokens: policy.runMaxTokens,
            reserveImages: parsed.reservedImages,
            policy,
          });

          const [run] = await tx.insert(runs).values({
            ownerUserId,
            projectId: parsed.projectId,
            idempotencyKey: parsed.idempotencyKey,
          }).returning();
          if (!run) throw new Error("No se pudo crear el run");
          const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
          const [reservation] = await tx.insert(usageReservations).values({
            ownerUserId,
            projectId: parsed.projectId,
            runId: run.id,
            idempotencyKey: parsed.idempotencyKey,
            reservedTokens: policy.runMaxTokens,
            reservedImages: parsed.reservedImages,
            expiresAt,
          }).returning({ id: usageReservations.id });
          if (!reservation) throw new Error("No se pudo reservar el presupuesto del run");
          await tx.insert(runOutbox).values({
            ownerUserId,
            projectId: parsed.projectId,
            runId: run.id,
            idempotencyKey: parsed.idempotencyKey,
          });
          await tx.insert(runEvents).values({
            ownerUserId,
            projectId: parsed.projectId,
            runId: run.id,
            sequence: 1,
            type: "run.queued",
            payload: { reservationId: reservation.id, outboxGeneration: 0 },
          });
          return { run, created: true };
        });
      },

      async cancelRun(identity: VerifiedIdentityContext, runId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedRunId = uuidSchema.parse(runId);
        return db.transaction(async (tx) => {
          const [candidate] = await tx.select({ projectId: runs.projectId }).from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId),
          )).limit(1);
          if (!candidate) throw new OwnedResourceNotFoundError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId),
            eq(projects.id, candidate.projectId),
            isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [run] = await tx.select().from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId),
            eq(runs.projectId, candidate.projectId),
            eq(runs.id, parsedRunId),
          )).for("update").limit(1);
          if (!run) throw new OwnedResourceNotFoundError();
          if (run.status === "queued") {
            const now = new Date();
            const [cancelled] = await tx.update(runs).set({ status: "cancelled", updatedAt: now }).where(eq(runs.id, run.id)).returning();
            if (!cancelled) throw new OwnedResourceNotFoundError();
            await tx.update(usageReservations).set({ status: "released", updatedAt: now }).where(and(
              eq(usageReservations.ownerUserId, ownerUserId),
              eq(usageReservations.runId, run.id),
              eq(usageReservations.status, "reserved"),
            ));
            await tx.update(runOutbox).set({ status: "dispatched", leaseToken: null, leaseExpiresAt: null, dispatchedAt: now, updatedAt: now }).where(and(
              eq(runOutbox.runId, run.id),
              sql`${runOutbox.status} in ('pending', 'dispatching')`,
            ));
            const [sequence] = await tx.select({ value: sql<number>`coalesce(max(${runEvents.sequence}), 0) + 1` })
              .from(runEvents).where(and(eq(runEvents.ownerUserId, ownerUserId), eq(runEvents.runId, run.id)));
            await tx.insert(runEvents).values({
              ownerUserId,
              projectId: run.projectId,
              runId: run.id,
              sequence: sequence?.value ?? 1,
              type: "run.cancelled",
              payload: { reservationReleased: true },
            });
            return cancelled;
          }
          if (run.status === "planning" || run.status === "running" || run.status === "verifying") {
            const now = new Date();
            const [requested] = await tx.update(runs).set({ cancelRequestedAt: run.cancelRequestedAt ?? now, updatedAt: now })
              .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, run.id))).returning();
            if (!requested) throw new OwnedResourceNotFoundError();
            if (!run.cancelRequestedAt) {
              const [sequence] = await tx.select({ value: sql<number>`coalesce(max(${runEvents.sequence}), 0) + 1` })
                .from(runEvents).where(and(eq(runEvents.ownerUserId, ownerUserId), eq(runEvents.runId, run.id)));
              await tx.insert(runEvents).values({
                ownerUserId,
                projectId: run.projectId,
                runId: run.id,
                sequence: sequence?.value ?? 1,
                type: "run.cancel_requested",
                payload: {},
              });
            }
            return requested;
          }
          return run;
        });
      },

      async create(identity: VerifiedIdentityContext, input: z.input<typeof runInputSchema>) {
        const parsed = runInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        return db.transaction(async (tx) => {
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [inserted] = await tx.insert(runs).values({
            ownerUserId, projectId: parsed.projectId, idempotencyKey: parsed.idempotencyKey,
          }).onConflictDoNothing({ target: [runs.ownerUserId, runs.idempotencyKey] }).returning();
          if (inserted) return inserted;
          const [existing] = await tx.select().from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId), eq(runs.idempotencyKey, parsed.idempotencyKey),
          )).limit(1);
          if (!existing) throw new Error("No se pudo reconciliar la clave de idempotencia");
          if (existing.projectId !== parsed.projectId) throw new IdempotencyConflictError();
          return existing;
        });
      },

      async get(identity: VerifiedIdentityContext, runId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedRunId = uuidSchema.parse(runId);
        const [run] = await db
          .select()
          .from(runs)
          .innerJoin(projects, and(eq(projects.ownerUserId, runs.ownerUserId), eq(projects.id, runs.projectId)))
          .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId), isNull(projects.deletedAt)))
          .limit(1);
        return run?.runs;
      },

      async setStatus(
        identity: VerifiedIdentityContext,
        runId: string,
        status: "queued" | "planning" | "running" | "verifying" | "succeeded" | "failed" | "cancelled",
        errorCode?: string,
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedRunId = uuidSchema.parse(runId);
        return db.transaction(async (tx) => {
          const [ownedRun] = await tx.select({ projectId: runs.projectId }).from(runs)
            .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId))).limit(1);
          if (!ownedRun) throw new OwnedResourceNotFoundError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, ownedRun.projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [run] = await tx.update(runs)
            .set({ status, errorCode: errorCode ?? null, updatedAt: new Date() })
            .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId)))
            .returning();
          if (!run) throw new OwnedResourceNotFoundError();
          return run;
        });
      },

      async appendEvent(identity: VerifiedIdentityContext, runId: string, input: z.input<typeof runEventInputSchema>) {
        const parsed = runEventInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedRunId = uuidSchema.parse(runId);
        return db.transaction(async (tx) => {
          const [candidate] = await tx.select({ projectId: runs.projectId }).from(runs)
            .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId))).limit(1);
          if (!candidate) throw new OwnedResourceNotFoundError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, candidate.projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [run] = await tx.select({ id: runs.id, projectId: runs.projectId }).from(runs)
            .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId))).for("update").limit(1);
          if (!run) throw new OwnedResourceNotFoundError();
          const [sequence] = await tx
            .select({ value: sql<number>`coalesce(max(${runEvents.sequence}), 0) + 1` })
            .from(runEvents)
            .where(and(eq(runEvents.ownerUserId, ownerUserId), eq(runEvents.runId, run.id)));
          const [event] = await tx
            .insert(runEvents)
            .values({
              ownerUserId,
              projectId: run.projectId,
              runId: run.id,
              sequence: sequence?.value ?? 1,
              type: parsed.type,
              payload: parsed.payload,
            })
            .returning();
          if (!event) throw new Error("No se pudo guardar el evento del run");
          return event;
        });
      },

      async listEvents(
        identity: VerifiedIdentityContext,
        runId: string,
        input: { afterSequence?: number; limit?: number } = {},
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedRunId = uuidSchema.parse(runId);
        const { afterSequence, limit } = listEventInputSchema.parse(input);
        const [run] = await db
          .select({ id: runs.id })
          .from(runs)
          .innerJoin(projects, and(eq(projects.ownerUserId, runs.ownerUserId), eq(projects.id, runs.projectId)))
          .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId), isNull(projects.deletedAt)))
          .limit(1);
        if (!run) throw new OwnedResourceNotFoundError();
        return db
          .select()
          .from(runEvents)
          .where(
            and(
              eq(runEvents.ownerUserId, ownerUserId),
              eq(runEvents.runId, parsedRunId),
              sql`${runEvents.sequence} > ${afterSequence}`,
            ),
          )
          .orderBy(asc(runEvents.sequence))
          .limit(limit);
      },
    },

    sandboxes: {
      async upsert(
        identity: VerifiedIdentityContext,
        input: {
          projectId: string;
          runtimeId?: string | null;
          status: "provisioning" | "ready" | "stopping" | "stopped" | "failed";
          leaseExpiresAt?: Date | null;
        },
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const projectId = uuidSchema.parse(input.projectId);
        return db.transaction(async (tx) => {
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [sandbox] = await tx.insert(sandboxes).values({
            ownerUserId,
            projectId,
            runtimeId: input.runtimeId ?? null,
            status: input.status,
            leaseExpiresAt: input.leaseExpiresAt ?? null,
          }).onConflictDoUpdate({
            target: [sandboxes.ownerUserId, sandboxes.projectId],
            set: {
              runtimeId: input.runtimeId ?? null,
              status: input.status,
              leaseExpiresAt: input.leaseExpiresAt ?? null,
              updatedAt: new Date(),
            },
          }).returning();
          if (!sandbox) throw new Error("No se pudo guardar el sandbox");
          return sandbox;
        });
      },

      async getForProject(identity: VerifiedIdentityContext, projectId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        await assertOwnedProject(db, ownerUserId, parsedProjectId);
        const [sandbox] = await db
          .select()
          .from(sandboxes)
          .where(and(eq(sandboxes.ownerUserId, ownerUserId), eq(sandboxes.projectId, parsedProjectId)))
          .limit(1);
        return sandbox;
      },
    },

    assets: {
      async createPending(
        identity: VerifiedIdentityContext,
        input: z.input<typeof assetInputSchema>,
      ) {
        const parsed = assetInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        const id = randomUUID();
        const objectKey = `private/${ownerUserId}/projects/${parsed.projectId}/assets/${id}`;
        return db.transaction(async (tx) => {
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [asset] = await tx.insert(assets)
            .values({ id, ownerUserId, objectKey, status: "pending", ...parsed })
            .returning();
          if (!asset) throw new Error("No se pudo reservar el asset");
          return asset;
        });
      },

      async getReady(identity: VerifiedIdentityContext, assetId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [asset] = await db
          .select()
          .from(assets)
          .where(
            and(
              eq(assets.ownerUserId, ownerUserId),
              eq(assets.id, uuidSchema.parse(assetId)),
              eq(assets.status, "ready"),
            ),
          )
          .limit(1);
        return asset;
      },

      async completeUpload(
        identity: VerifiedIdentityContext,
        assetId: string,
        checksum: string,
        sizeBytes: number,
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedAssetId = uuidSchema.parse(assetId);
        const [asset] = await db
          .update(assets)
          .set({ status: "ready", updatedAt: new Date() })
          .where(
            and(
              eq(assets.ownerUserId, ownerUserId),
              eq(assets.id, parsedAssetId),
              eq(assets.status, "pending"),
              eq(assets.sha256, checksum),
              eq(assets.sizeBytes, sizeBytes),
            ),
          )
          .returning();
        if (!asset) throw new OwnedResourceNotFoundError();
        return asset;
      },

      async markFailed(identity: VerifiedIdentityContext, assetId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [asset] = await db
          .update(assets)
          .set({ status: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(assets.ownerUserId, ownerUserId),
              eq(assets.id, uuidSchema.parse(assetId)),
              eq(assets.status, "pending"),
            ),
          )
          .returning();
        if (!asset) throw new OwnedResourceNotFoundError();
        return asset;
      },

      async requestDelete(identity: VerifiedIdentityContext, assetId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedAssetId = uuidSchema.parse(assetId);
        const [asset] = await db
          .update(assets)
          .set({ status: "delete_requested", updatedAt: new Date() })
          .where(
            and(
              eq(assets.ownerUserId, ownerUserId),
              eq(assets.id, parsedAssetId),
              sql`${assets.status} in ('pending', 'ready', 'failed')`,
            ),
          )
          .returning();
        if (!asset) throw new OwnedResourceNotFoundError();
        return asset;
      },

      async finishDelete(identity: VerifiedIdentityContext, assetId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [asset] = await db
          .delete(assets)
          .where(
            and(
              eq(assets.ownerUserId, ownerUserId),
              eq(assets.id, uuidSchema.parse(assetId)),
              eq(assets.status, "delete_requested"),
            ),
          )
          .returning({ id: assets.id });
        if (!asset) throw new OwnedResourceNotFoundError();
        return asset;
      },

      async list(
        identity: VerifiedIdentityContext,
        projectId: string,
        input: { limit?: number; cursor?: string } = {},
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        await assertOwnedProject(db, ownerUserId, parsedProjectId);
        const { limit, cursor: rawCursor } = pageInputSchema.parse(input);
        const cursor = decodeCursor(rawCursor);
        const where = cursor
          ? and(
              eq(assets.ownerUserId, ownerUserId),
              eq(assets.projectId, parsedProjectId),
              or(
                lt(assets.createdAt, cursor.createdAt),
                and(eq(assets.createdAt, cursor.createdAt), lt(assets.id, cursor.id)),
              ),
            )
          : and(eq(assets.ownerUserId, ownerUserId), eq(assets.projectId, parsedProjectId));
        const rows = await db
          .select({
            id: assets.id,
            projectId: assets.projectId,
            contentType: assets.contentType,
            sizeBytes: assets.sizeBytes,
            sha256: assets.sha256,
            status: assets.status,
            createdAt: assets.createdAt,
          })
          .from(assets)
          .where(where)
          .orderBy(desc(assets.createdAt), desc(assets.id))
          .limit(limit + 1);
        return makePage(rows, limit);
      },
    },

    versions: {
      async create(
        identity: VerifiedIdentityContext,
        input: z.input<typeof versionInputSchema>,
      ) {
        const parsed = versionInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        const id = randomUUID();
        return db.transaction(async (tx) => {
          const [project] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), isNull(projects.deletedAt)))
            .for("update")
            .limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [next] = await tx
            .select({ value: sql<number>`coalesce(max(${versions.versionNumber}), 0) + 1` })
            .from(versions)
            .where(
              and(
                eq(versions.ownerUserId, ownerUserId),
                eq(versions.projectId, parsed.projectId),
              ),
            );
          const versionNumber = next?.value ?? 1;
          const snapshotKey = `private/${ownerUserId}/projects/${parsed.projectId}/versions/${id}`;
          const [version] = await tx
            .insert(versions)
            .values({
              id,
              ownerUserId,
              projectId: parsed.projectId,
              versionNumber,
              snapshotKey,
              sha256: parsed.sha256,
              sizeBytes: parsed.sizeBytes,
            })
            .returning();
          if (!version) throw new Error("No se pudo crear la versión");
          return version;
        });
      },

      async setStatus(
        identity: VerifiedIdentityContext,
        versionId: string,
        status: "creating" | "ready" | "failed",
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedVersionId = uuidSchema.parse(versionId);
        return db.transaction(async (tx) => {
          const [candidate] = await tx.select({ projectId: versions.projectId }).from(versions)
            .where(and(eq(versions.ownerUserId, ownerUserId), eq(versions.id, parsedVersionId))).limit(1);
          if (!candidate) throw new OwnedResourceNotFoundError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, candidate.projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [version] = await tx.update(versions).set({ status }).where(and(
            eq(versions.ownerUserId, ownerUserId), eq(versions.id, parsedVersionId), sql`${versions.status} <> 'delete_requested'`,
          )).returning();
          if (!version) throw new OwnedResourceNotFoundError();
          return version;
        });
      },

      async list(
        identity: VerifiedIdentityContext,
        projectId: string,
        input: { limit?: number; cursor?: string } = {},
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        await assertOwnedProject(db, ownerUserId, parsedProjectId);
        const { limit, cursor: rawCursor } = pageInputSchema.parse(input);
        const cursor = decodeCursor(rawCursor);
        const where = cursor
          ? and(
              eq(versions.ownerUserId, ownerUserId),
              eq(versions.projectId, parsedProjectId),
              or(
                lt(versions.createdAt, cursor.createdAt),
                and(eq(versions.createdAt, cursor.createdAt), lt(versions.id, cursor.id)),
              ),
            )
          : and(eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, parsedProjectId));
        const rows = await db
          .select({
            id: versions.id,
            projectId: versions.projectId,
            versionNumber: versions.versionNumber,
            sha256: versions.sha256,
            sizeBytes: versions.sizeBytes,
            status: versions.status,
            createdAt: versions.createdAt,
          })
          .from(versions)
          .where(where)
          .orderBy(desc(versions.createdAt), desc(versions.id))
          .limit(limit + 1);
        return makePage(rows, limit);
      },
    },

    publications: {
      async create(
        identity: VerifiedIdentityContext,
        input: { projectId: string; versionId: string },
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const projectId = uuidSchema.parse(input.projectId);
        const versionId = uuidSchema.parse(input.versionId);
        return db.transaction(async (tx) => {
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [version] = await tx.select({ id: versions.id }).from(versions).where(and(
            eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, projectId),
            eq(versions.id, versionId), eq(versions.status, "ready"),
          )).limit(1);
          if (!version) throw new OwnedResourceNotFoundError();
          const id = randomUUID();
          const slug = randomUUID().replaceAll("-", "").slice(0, 20);
          const artifactKey = `published/${ownerUserId}/projects/${projectId}/${id}`;
          const [publication] = await tx.insert(publications)
            .values({ id, ownerUserId, projectId, versionId, slug, artifactKey })
            .returning();
          if (!publication) throw new Error("No se pudo crear la publicación");
          return publication;
        });
      },

      async setStatus(
        identity: VerifiedIdentityContext,
        publicationId: string,
        status: "building" | "published" | "revoked" | "failed",
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedPublicationId = uuidSchema.parse(publicationId);
        return db.transaction(async (tx) => {
          const [candidate] = await tx.select({ projectId: publications.projectId }).from(publications)
            .where(and(eq(publications.ownerUserId, ownerUserId), eq(publications.id, parsedPublicationId))).limit(1);
          if (!candidate) throw new OwnedResourceNotFoundError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, candidate.projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [publication] = await tx.update(publications).set({ status, updatedAt: new Date() }).where(and(
            eq(publications.ownerUserId, ownerUserId), eq(publications.id, parsedPublicationId),
          )).returning();
          if (!publication) throw new OwnedResourceNotFoundError();
          return publication;
        });
      },

      async list(
        identity: VerifiedIdentityContext,
        projectId: string,
        input: { limit?: number; cursor?: string } = {},
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        await assertOwnedProject(db, ownerUserId, parsedProjectId);
        const { limit, cursor: rawCursor } = pageInputSchema.parse(input);
        const cursor = decodeCursor(rawCursor);
        const where = cursor
          ? and(
              eq(publications.ownerUserId, ownerUserId),
              eq(publications.projectId, parsedProjectId),
              or(
                lt(publications.createdAt, cursor.createdAt),
                and(eq(publications.createdAt, cursor.createdAt), lt(publications.id, cursor.id)),
              ),
            )
          : and(
              eq(publications.ownerUserId, ownerUserId),
              eq(publications.projectId, parsedProjectId),
            );
        const rows = await db
          .select({
            id: publications.id,
            projectId: publications.projectId,
            versionId: publications.versionId,
            slug: publications.slug,
            status: publications.status,
            createdAt: publications.createdAt,
          })
          .from(publications)
          .where(where)
          .orderBy(desc(publications.createdAt), desc(publications.id))
          .limit(limit + 1);
        return makePage(rows, limit);
      },
    },

    usage: {
      async reserve(identity: VerifiedIdentityContext, input: z.input<typeof usageInputSchema>) {
        const parsed = usageInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        return db.transaction(async (tx) => {
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [inserted] = await tx.insert(usageReservations).values({ ...parsed, ownerUserId })
            .onConflictDoNothing({ target: [usageReservations.ownerUserId, usageReservations.idempotencyKey] }).returning();
          if (inserted) return inserted;
          const [existing] = await tx.select().from(usageReservations).where(and(
            eq(usageReservations.ownerUserId, ownerUserId), eq(usageReservations.idempotencyKey, parsed.idempotencyKey),
          )).limit(1);
          if (!existing) throw new Error("No se pudo reconciliar la reserva de uso");
          if (existing.projectId !== parsed.projectId) throw new IdempotencyConflictError();
          return existing;
        });
      },

      async setReservationStatus(
        identity: VerifiedIdentityContext,
        reservationId: string,
        status: "reserved" | "committed" | "released" | "expired",
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedReservationId = uuidSchema.parse(reservationId);
        return db.transaction(async (tx) => {
          const [candidate] = await tx.select({ projectId: usageReservations.projectId }).from(usageReservations)
            .where(and(eq(usageReservations.ownerUserId, ownerUserId), eq(usageReservations.id, parsedReservationId))).limit(1);
          if (!candidate) throw new OwnedResourceNotFoundError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, candidate.projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [reservation] = await tx.update(usageReservations).set({ status, updatedAt: new Date() }).where(and(
            eq(usageReservations.ownerUserId, ownerUserId), eq(usageReservations.id, parsedReservationId),
          )).returning();
          if (!reservation) throw new OwnedResourceNotFoundError();
          return reservation;
        });
      },

      async record(identity: VerifiedIdentityContext, input: z.input<typeof ledgerInputSchema>) {
        const parsed = ledgerInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        return db.transaction(async (tx) => {
          const [reservation] = await tx.select({ id: usageReservations.id, projectId: usageReservations.projectId })
            .from(usageReservations)
            .where(and(eq(usageReservations.ownerUserId, ownerUserId), eq(usageReservations.id, parsed.reservationId)))
            .limit(1);
          if (!reservation) throw new OwnedResourceNotFoundError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, reservation.projectId), isNull(projects.deletedAt),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [inserted] = await tx.insert(usageLedger)
            .values({ ...parsed, ownerUserId, projectId: reservation.projectId })
            .onConflictDoNothing({ target: [usageLedger.ownerUserId, usageLedger.idempotencyKey] })
            .returning();
          if (inserted) return inserted;
          const [existing] = await tx.select().from(usageLedger).where(and(
            eq(usageLedger.ownerUserId, ownerUserId), eq(usageLedger.idempotencyKey, parsed.idempotencyKey),
          )).limit(1);
          if (!existing) throw new Error("No se pudo reconciliar el asiento de uso");
          if (existing.projectId !== reservation.projectId || existing.reservationId !== reservation.id) {
            throw new IdempotencyConflictError();
          }
          return existing;
        });
      },

      async listLedger(
        identity: VerifiedIdentityContext,
        projectId: string,
        input: { limit?: number; cursor?: string } = {},
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        await assertOwnedProject(db, ownerUserId, parsedProjectId);
        const { limit, cursor: rawCursor } = pageInputSchema.parse(input);
        const cursor = decodeCursor(rawCursor);
        const where = cursor
          ? and(
              eq(usageLedger.ownerUserId, ownerUserId),
              eq(usageLedger.projectId, parsedProjectId),
              or(
                lt(usageLedger.createdAt, cursor.createdAt),
                and(eq(usageLedger.createdAt, cursor.createdAt), lt(usageLedger.id, cursor.id)),
              ),
            )
          : and(eq(usageLedger.ownerUserId, ownerUserId), eq(usageLedger.projectId, parsedProjectId));
        const rows = await db
          .select()
          .from(usageLedger)
          .where(where)
          .orderBy(desc(usageLedger.createdAt), desc(usageLedger.id))
          .limit(limit + 1);
        return makePage(rows, limit);
      },
    },
  };
}
