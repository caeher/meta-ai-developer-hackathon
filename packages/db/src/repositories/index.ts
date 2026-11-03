import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { GameDatabase } from "../database";
import {
  assertVerifiedIdentityContext,
  ContributorConsentRequiredError,
  IdempotencyConflictError,
  OwnedResourceNotFoundError,
  ProjectRunBusyError,
  StaleRunWorkerError,
  UsageLimitExceededError,
  type VerifiedIdentityContext,
} from "../identity";
import { assertRunQuotaAvailable, RunQuotaPolicySchema, utcDayStart, type RunQuotaPolicy } from "../usage";
import {
  assets,
  messages,
  projects,
  projectRunLocks,
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
  assetId: uuidSchema.optional(),
  projectId: uuidSchema,
  contentType: z.string().trim().min(1).max(150),
  sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: z.record(z.string(), z.unknown()).default({}).refine((value) => {
    try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= 64 * 1024; }
    catch { return false; }
  }, "Asset metadata exceeds 64 KiB"),
});
const versionManifestSchema = z.record(z.string().max(100), z.unknown()).refine((value) => {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= 128 * 1024; }
  catch { return false; }
}, "Version manifest exceeds 128 KiB");
const versionInputSchema = z.object({
  versionId: uuidSchema.optional(),
  projectId: uuidSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  parentVersionId: uuidSchema.nullable().optional(),
  manifest: versionManifestSchema.optional(),
  storageLimitBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
const runVersionInputSchema = z.object({
  versionId: uuidSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(25 * 1024 * 1024),
  parentVersionId: uuidSchema.nullable(),
  manifest: versionManifestSchema,
  storageLimitBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
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
  messageRequestId: z.string().trim().min(8).max(128).optional(),
  /** @deprecated El consentimiento deriva de users.contributor_consent_at; se acepta y se ignora. */
  contributorConsent: z.boolean().optional(),
  reservedImages: z.number().int().nonnegative().max(100_000).default(0),
  policy: RunQuotaPolicySchema,
});
const repositoryPolicySchema = z.object({
  maxProjects: z.number().int().min(1).max(10_000).default(50),
  maxStorageBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1_024 * 1024 * 1024),
  maxConcurrentJobs: z.number().int().min(1).max(100).default(1),
  runMaxTokens: z.number().int().min(1).max(2_000_000).default(16_000),
  dailyTokenLimit: z.number().int().min(1).max(20_000_000).default(100_000),
  dailyImageLimit: z.number().int().min(1).max(100_000).default(10),
  runMaxDurationMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
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
  return identity.userId;
}

async function resolveOwnerId(db: GameDatabase, identity: VerifiedIdentityContext): Promise<string> {
  const userId = requireContext(identity);
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.userId, userId), isNull(users.deletedAt)))
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
    .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false))))
    .limit(1);
  if (!project) throw new OwnedResourceNotFoundError();
}

export function createRepositories(db: GameDatabase, policyInput: Partial<z.input<typeof repositoryPolicySchema>> = {}) {
  const policy = repositoryPolicySchema.parse(policyInput);
  async function storageBytes(tx: Parameters<Parameters<GameDatabase["transaction"]>[0]>[0], ownerUserId: string) {
    const [assetUsage] = await tx.select({ bytes: sql<number>`coalesce(sum(${assets.sizeBytes}), 0)` }).from(assets)
      .where(eq(assets.ownerUserId, ownerUserId));
    const [snapshotUsage] = await tx.select({ bytes: sql<number>`coalesce(sum(${versions.sizeBytes}), 0)` }).from(versions)
      .where(eq(versions.ownerUserId, ownerUserId));
    const [reservedUsage] = await tx.select({ bytes: sql<number>`coalesce(sum(${usageReservations.reservedStorageBytes}), 0)` }).from(usageReservations)
      .where(and(eq(usageReservations.ownerUserId, ownerUserId), eq(usageReservations.status, "reserved")));
    const [lifecycleUsage] = await tx.select({ bytes: sql<number>`coalesce(sum(${sandboxes.lifecycleSnapshotSizeBytes}), 0)` }).from(sandboxes)
      .where(eq(sandboxes.ownerUserId, ownerUserId));
    return Number(assetUsage?.bytes ?? 0) + Number(snapshotUsage?.bytes ?? 0) + Number(reservedUsage?.bytes ?? 0) + Number(lifecycleUsage?.bytes ?? 0);
  }
  async function assertStorageCapacity(tx: Parameters<Parameters<GameDatabase["transaction"]>[0]>[0], ownerUserId: string, bytesToAdd: number, limit = policy.maxStorageBytes) {
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).for("update").limit(1);
    if (!owner) throw new OwnedResourceNotFoundError();
    if (await storageBytes(tx, ownerUserId) + bytesToAdd > limit) throw new UsageLimitExceededError("storage");
  }
  return {
    projects: {
      async create(identity: VerifiedIdentityContext, input: { name: string }) {
        const userId = requireContext(identity);
        const name = projectNameSchema.parse(input.name);
        return db.transaction(async (tx) => {
          const [owner] = await tx.insert(users).values({ userId }).onConflictDoUpdate({
            target: users.userId, set: { updatedAt: new Date() },
          }).returning({ id: users.id, deletedAt: users.deletedAt });
          if (!owner) throw new Error("No se pudo resolver el dueño del proyecto");
          if (owner.deletedAt) throw new OwnedResourceNotFoundError();
          await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.id)).for("update").limit(1);
          const [activeProjects] = await tx.select({ count: sql<number>`count(*)` }).from(projects).where(and(
            eq(projects.ownerUserId, owner.id), isNull(projects.deletedAt), eq(projects.isInternal, false),
          ));
          if (Number(activeProjects?.count ?? 0) >= policy.maxProjects) throw new UsageLimitExceededError("projects");
          const [project] = await tx.insert(projects).values({ ownerUserId: owner.id, name }).returning();
          if (!project) throw new Error("No se pudo crear el proyecto");
          return project;
        });
      },

      async createBuildWorkspace(identity: VerifiedIdentityContext) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [project] = await db.insert(projects).values({
          ownerUserId,
          name: "Build privado",
          isInternal: true,
        }).returning();
        if (!project) throw new Error("No se pudo crear el workspace de build");
        return project;
      },

      async deleteBuildWorkspace(identity: VerifiedIdentityContext, projectId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [deleted] = await db.delete(projects).where(and(
          eq(projects.ownerUserId, ownerUserId),
          eq(projects.id, uuidSchema.parse(projectId)),
          eq(projects.isInternal, true),
        )).returning({ id: projects.id });
        if (!deleted) throw new OwnedResourceNotFoundError();
        return deleted;
      },

      async reapBuildWorkspaces(cutoff: Date, limit = 50) {
        const candidates = await db.select({ id: projects.id, ownerUserId: projects.ownerUserId }).from(projects).where(and(
          eq(projects.isInternal, true), lt(projects.createdAt, cutoff),
        )).orderBy(asc(projects.createdAt)).limit(Math.max(1, Math.min(100, Math.trunc(limit))));
        let deleted = 0;
        for (const candidate of candidates) {
          const [sandbox] = await db.select({ status: sandboxes.status })
            .from(sandboxes).where(and(
              eq(sandboxes.ownerUserId, candidate.ownerUserId), eq(sandboxes.projectId, candidate.id),
            )).limit(1);
          // Keep the project/sandbox registration until the controller confirms runtime destruction.
          if (sandbox && sandbox.status !== "stopped") continue;
          const [removed] = await db.delete(projects).where(and(
            eq(projects.id, candidate.id), eq(projects.ownerUserId, candidate.ownerUserId),
            eq(projects.isInternal, true), lt(projects.createdAt, cutoff),
          )).returning({ id: projects.id });
          if (removed) deleted += 1;
        }
        return { deleted };
      },

      async get(identity: VerifiedIdentityContext, projectId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        const [project] = await db
          .select()
          .from(projects)
          .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsedProjectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false))))
          .limit(1);
        return project;
      },

      async rename(identity: VerifiedIdentityContext, projectId: string, name: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        const [project] = await db
          .update(projects)
          .set({ name: projectNameSchema.parse(name), updatedAt: new Date() })
          .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsedProjectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false))))
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
              and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
              or(
                lt(projects.createdAt, cursor.createdAt),
                and(eq(projects.createdAt, cursor.createdAt), lt(projects.id, cursor.id)),
              ),
            )
          : and(eq(projects.ownerUserId, ownerUserId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)));
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
              and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
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
          await tx.update(runOutbox).set({
            status: "cancelled", leaseToken: null, leaseExpiresAt: null, updatedAt: deletedAt,
          }).where(and(eq(runOutbox.ownerUserId, ownerUserId), eq(runOutbox.projectId, parsedProjectId)));
          await tx.update(sandboxes)
            .set({ status: "stopping", lifecycleLeaseToken: null, lifecycleLeaseExpiresAt: null, updatedAt: deletedAt })
            .where(and(eq(sandboxes.ownerUserId, ownerUserId), eq(sandboxes.projectId, parsedProjectId)));
          await tx.update(assets)
            .set({ status: "delete_requested", updatedAt: deletedAt })
            .where(and(eq(assets.ownerUserId, ownerUserId), eq(assets.projectId, parsedProjectId)));
          await tx.update(versions)
            .set({ status: "delete_requested" })
            .where(and(eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, parsedProjectId)));
          await tx.update(publications)
            .set({ status: "revoked", buildLeaseToken: null, buildLeaseExpiresAt: null, updatedAt: deletedAt })
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
            .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false))))
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
      async requireContributorConsent(identity: VerifiedIdentityContext): Promise<void> {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [row] = await db.select({ contributorConsentAt: users.contributorConsentAt }).from(users).where(eq(users.id, ownerUserId)).limit(1);
        if (!row?.contributorConsentAt) throw new ContributorConsentRequiredError();
      },

      async enqueueRun(identity: VerifiedIdentityContext, input: z.input<typeof enqueueRunInputSchema>) {
        const parsed = enqueueRunInputSchema.parse(input);
        const policy: RunQuotaPolicy = RunQuotaPolicySchema.parse(parsed.policy);
        const ownerUserId = await resolveOwnerId(db, identity);
        return db.transaction(async (tx) => {
          const [owner] = await tx.select({ id: users.id }).from(users)
            .where(eq(users.id, ownerUserId)).for("update").limit(1);
          if (!owner) throw new OwnedResourceNotFoundError();
          const [consent] = await tx.select({ contributorConsentAt: users.contributorConsentAt }).from(users)
            .where(eq(users.id, ownerUserId)).for("update").limit(1);
          if (!consent?.contributorConsentAt) throw new ContributorConsentRequiredError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId),
            eq(projects.id, parsed.projectId),
            and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [sandbox] = await tx.select({ status: sandboxes.status, lifecycleLeaseExpiresAt: sandboxes.lifecycleLeaseExpiresAt })
            .from(sandboxes).where(and(
              eq(sandboxes.ownerUserId, ownerUserId), eq(sandboxes.projectId, parsed.projectId),
            )).for("update").limit(1);
          if (sandbox?.status === "suspending" || (sandbox?.lifecycleLeaseExpiresAt && sandbox.lifecycleLeaseExpiresAt > new Date())) {
            throw new ProjectRunBusyError();
          }

          const [sourceMessage] = parsed.messageRequestId
            ? await tx.select().from(messages).where(and(
                eq(messages.ownerUserId, ownerUserId),
                eq(messages.projectId, parsed.projectId),
                eq(messages.requestId, parsed.messageRequestId),
                eq(messages.role, "user"),
              )).for("update").limit(1)
            : [];
          if (parsed.messageRequestId && !sourceMessage) throw new OwnedResourceNotFoundError();

          const [existing] = await tx.select().from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId),
            eq(runs.idempotencyKey, parsed.idempotencyKey),
          )).limit(1);
          if (existing) {
            if (existing.projectId !== parsed.projectId) throw new IdempotencyConflictError();
            if (sourceMessage && sourceMessage.runId !== existing.id) {
              const [origin] = await tx.select({ payload: runEvents.payload }).from(runEvents).where(and(
                eq(runEvents.ownerUserId, ownerUserId),
                eq(runEvents.runId, existing.id),
                eq(runEvents.sequence, 1),
                eq(runEvents.type, "run.queued"),
              )).limit(1);
              const sourceMessageId = origin?.payload && typeof origin.payload === "object" && !Array.isArray(origin.payload)
                ? (origin.payload as Record<string, unknown>).sourceMessageId
                : undefined;
              if (sourceMessageId !== sourceMessage.id) throw new IdempotencyConflictError();
            }
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
            contributorConsent: true,
          }).returning();
          if (!run) throw new Error("No se pudo crear el run");
          if (sourceMessage) {
            const [linked] = await tx.update(messages).set({ runId: run.id }).where(and(
              eq(messages.ownerUserId, ownerUserId),
              eq(messages.projectId, parsed.projectId),
              eq(messages.id, sourceMessage.id),
            )).returning({ id: messages.id });
            if (!linked) throw new IdempotencyConflictError();
          }
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
            payload: {
              reservationId: reservation.id,
              outboxGeneration: 0,
              contributorConsent: true,
              ...(sourceMessage ? { sourceMessageId: sourceMessage.id } : {}),
            },
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
            and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
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
          await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).for("update").limit(1);
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
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
          .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId), and(isNull(projects.deletedAt), eq(projects.isInternal, false))))
          .limit(1);
        return run?.runs;
      },

      async latest(identity: VerifiedIdentityContext, projectId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        const [project] = await db.select({ id: projects.id }).from(projects).where(and(
          eq(projects.ownerUserId, ownerUserId),
          eq(projects.id, parsedProjectId),
          and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
        )).limit(1);
        if (!project) throw new OwnedResourceNotFoundError();
        const [run] = await db.select().from(runs).where(and(
          eq(runs.ownerUserId, ownerUserId),
          eq(runs.projectId, parsedProjectId),
        )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
        if (!run) return undefined;
        const [sourceMessage] = await db.select({ requestId: messages.requestId }).from(messages).where(and(
          eq(messages.ownerUserId, ownerUserId),
          eq(messages.projectId, parsedProjectId),
          eq(messages.runId, run.id),
        )).orderBy(desc(messages.createdAt)).limit(1);
        return { ...run, sourceMessageRequestId: sourceMessage?.requestId };
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
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, ownedRun.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
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
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, candidate.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
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
          .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId), and(isNull(projects.deletedAt), eq(projects.isInternal, false))))
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
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
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
        const id = parsed.assetId ?? randomUUID();
        const assetData = {
          projectId: parsed.projectId,
          contentType: parsed.contentType,
          sizeBytes: parsed.sizeBytes,
          sha256: parsed.sha256,
          metadata: parsed.metadata,
        };
        const objectKey = `private/${ownerUserId}/projects/${parsed.projectId}/assets/${id}`;
        return db.transaction(async (tx) => {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).for("update").limit(1);
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          await assertStorageCapacity(tx, ownerUserId, parsed.sizeBytes);
          const [asset] = await tx.insert(assets)
            .values({ id, ownerUserId, objectKey, status: "pending", ...assetData })
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

      // ADR-0002: candidatos sin identidad de sesion; el worker reconcilia
      // filas pending/delete_requested/failed viejas contra S3 con CAS.
      async listAssetReconciliationCandidates(cutoff: Date, limit = 50) {
        if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 250) {
          throw new RangeError('Limites de reconciliacion invalidos');
        }
        return db.select().from(assets).where(and(
          inArray(assets.status, ['pending', 'delete_requested', 'failed']),
          lt(assets.updatedAt, cutoff),
        )).orderBy(asc(assets.updatedAt), asc(assets.id)).limit(limit);
      },

      async reconcileAssetCandidate(input: {
        id: string; ownerUserId: string; projectId: string; sha256: string; sizeBytes: number;
        updatedAt: Date; cutoff: Date; action: 'ready' | 'failed' | 'deleted' | 'cleaned';
      }) {
        const candidate = z.object({
          id: uuidSchema, ownerUserId: uuidSchema, projectId: uuidSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive(),
          updatedAt: z.date(), cutoff: z.date(), action: z.enum(['ready', 'failed', 'deleted', 'cleaned']),
        }).strict().parse(input);
        if (!Number.isFinite(candidate.updatedAt.getTime()) || !Number.isFinite(candidate.cutoff.getTime())) throw new TypeError('Fecha de reconciliacion invalida');
        const expectedStatus = candidate.action === 'deleted' ? 'delete_requested' : candidate.action === 'cleaned' ? 'failed' : 'pending';
        const where = and(
          eq(assets.id, candidate.id), eq(assets.ownerUserId, candidate.ownerUserId),
          eq(assets.projectId, candidate.projectId), eq(assets.status, expectedStatus),
          eq(assets.sha256, candidate.sha256), eq(assets.sizeBytes, candidate.sizeBytes),
          eq(assets.updatedAt, candidate.updatedAt), lt(assets.updatedAt, candidate.cutoff),
        );
        if (candidate.action === 'deleted') {
          const deleted = await db.delete(assets).where(where).returning({ id: assets.id });
          return deleted.length > 0;
        }
        const [updated] = await db.update(assets).set({ status: candidate.action === 'cleaned' ? 'failed' : candidate.action, updatedAt: new Date() }).where(where).returning({ id: assets.id });
        return Boolean(updated);
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
      async ownerId(identity: VerifiedIdentityContext, projectId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        await assertOwnedProject(db, ownerUserId, parsedProjectId);
        return ownerUserId;
      },

      async reserveForRun(
        identity: VerifiedIdentityContext,
        claim: { runId: string; ownerUserId: string; projectId: string; fencingToken: number },
        input: z.input<typeof runVersionInputSchema>,
      ) {
        const parsed = runVersionInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        if (ownerUserId !== claim.ownerUserId) throw new StaleRunWorkerError();
        const projectId = uuidSchema.parse(claim.projectId);
        const runId = uuidSchema.parse(claim.runId);
        return db.transaction(async (tx) => {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).for("update").limit(1);
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const now = new Date();
          const [lock] = await tx.select({ runId: projectRunLocks.runId }).from(projectRunLocks).where(and(
            eq(projectRunLocks.ownerUserId, ownerUserId), eq(projectRunLocks.projectId, projectId),
            eq(projectRunLocks.runId, runId), eq(projectRunLocks.fencingToken, claim.fencingToken),
            sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
          )).for("update").limit(1);
          const [run] = await tx.select({ id: runs.id }).from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId), eq(runs.projectId, projectId), eq(runs.id, runId),
            sql`${runs.status} in ('planning', 'running', 'verifying')`,
          )).for("update").limit(1);
          if (!lock || !run) throw new StaleRunWorkerError();

          const [existing] = await tx.select().from(versions).where(and(
            eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, projectId), eq(versions.runId, runId),
          )).for("update").limit(1);
          if (existing) {
            if (existing.parentVersionId !== parsed.parentVersionId || existing.sha256 !== parsed.sha256 || existing.sizeBytes !== parsed.sizeBytes) {
              throw new IdempotencyConflictError();
            }
            if (existing.id !== parsed.versionId) throw new IdempotencyConflictError();
            return existing;
          }
          await assertStorageCapacity(tx, ownerUserId, parsed.sizeBytes, parsed.storageLimitBytes ?? policy.maxStorageBytes);
          if (parsed.parentVersionId) {
            const [parent] = await tx.select({ id: versions.id }).from(versions).where(and(
              eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, projectId),
              eq(versions.id, parsed.parentVersionId), eq(versions.status, "ready"),
            )).limit(1);
            if (!parent) throw new OwnedResourceNotFoundError();
          }
          const [next] = await tx.select({ value: sql<number>`coalesce(max(${versions.versionNumber}), 0) + 1` }).from(versions)
            .where(and(eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, projectId)));
          const id = parsed.versionId;
          const [version] = await tx.insert(versions).values({
            id, ownerUserId, projectId, versionNumber: next?.value ?? 1, runId,
            parentVersionId: parsed.parentVersionId,
            snapshotKey: `private/${ownerUserId}/projects/${projectId}/versions/${id}`,
            sha256: parsed.sha256, sizeBytes: parsed.sizeBytes, manifest: parsed.manifest,
            status: "creating",
          }).returning();
          if (!version) throw new Error("No se pudo reservar la versión");
          return version;
        });
      },

      async markRunSnapshotReady(
        identity: VerifiedIdentityContext,
        claim: { runId: string; ownerUserId: string; projectId: string; fencingToken: number },
        versionId: string,
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedVersionId = uuidSchema.parse(versionId);
        if (ownerUserId !== claim.ownerUserId) throw new StaleRunWorkerError();
        return db.transaction(async (tx) => {
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, claim.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const now = new Date();
          const [lock] = await tx.select({ runId: projectRunLocks.runId }).from(projectRunLocks).where(and(
            eq(projectRunLocks.ownerUserId, ownerUserId), eq(projectRunLocks.projectId, claim.projectId),
            eq(projectRunLocks.runId, claim.runId), eq(projectRunLocks.fencingToken, claim.fencingToken),
            sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
          )).for("update").limit(1);
          if (!lock) throw new StaleRunWorkerError();
          const [version] = await tx.update(versions).set({ status: "ready" }).where(and(
            eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, claim.projectId),
            eq(versions.id, parsedVersionId), eq(versions.runId, claim.runId),
            sql`${versions.status} in ('creating', 'ready')`,
          )).returning();
          if (!version) throw new OwnedResourceNotFoundError();
          return version;
        });
      },

      async markRunSnapshotFailed(
        identity: VerifiedIdentityContext,
        claim: { runId: string; ownerUserId: string; projectId: string; fencingToken: number },
        versionId: string,
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedVersionId = uuidSchema.parse(versionId);
        if (ownerUserId !== claim.ownerUserId) throw new StaleRunWorkerError();
        return db.transaction(async (tx) => {
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, claim.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const now = new Date();
          const [lock] = await tx.select({ runId: projectRunLocks.runId }).from(projectRunLocks).where(and(
            eq(projectRunLocks.ownerUserId, ownerUserId), eq(projectRunLocks.projectId, claim.projectId),
            eq(projectRunLocks.runId, claim.runId), eq(projectRunLocks.fencingToken, claim.fencingToken),
            sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
          )).for("update").limit(1);
          if (!lock) throw new StaleRunWorkerError();
          const [version] = await tx.update(versions).set({ status: "failed" }).where(and(
            eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, claim.projectId),
            eq(versions.id, parsedVersionId), eq(versions.runId, claim.runId), eq(versions.status, "creating"),
          )).returning();
          if (!version) throw new OwnedResourceNotFoundError();
          return version;
        });
      },

      async get(identity: VerifiedIdentityContext, projectId: string, versionId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [version] = await db.select().from(versions).where(and(
          eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, uuidSchema.parse(projectId)),
          eq(versions.id, uuidSchema.parse(versionId)), eq(versions.status, "ready"),
        )).limit(1);
        return version;
      },

      async latest(identity: VerifiedIdentityContext, projectId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        await assertOwnedProject(db, ownerUserId, parsedProjectId);
        const [version] = await db.select().from(versions).where(and(
          eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, parsedProjectId), eq(versions.status, "ready"),
        )).orderBy(desc(versions.versionNumber)).limit(1);
        return version;
      },

      async acquireRestoreLock(identity: VerifiedIdentityContext, projectId: string, leaseMs = 60_000) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 120_000) throw new RangeError("Lease de restauración inválido");
        return db.transaction(async (tx) => {
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsedProjectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [activeRun] = await tx.select({ id: runs.id }).from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId), eq(runs.projectId, parsedProjectId),
            inArray(runs.status, ["queued", "planning", "running", "verifying"]),
          )).limit(1);
          if (activeRun) throw new ProjectRunBusyError();
          const now = new Date();
          const [prior] = await tx.select().from(projectRunLocks).where(and(
            eq(projectRunLocks.ownerUserId, ownerUserId), eq(projectRunLocks.projectId, parsedProjectId),
          )).for("update").limit(1);
          if (prior?.leaseExpiresAt && prior.leaseExpiresAt > now) throw new ProjectRunBusyError();
          const fencingToken = (prior?.fencingToken ?? 0) + 1;
          if (prior) {
            await tx.update(projectRunLocks).set({ runId: null, fencingToken, leaseExpiresAt: new Date(now.getTime() + leaseMs), heartbeatAt: now, updatedAt: now })
              .where(and(eq(projectRunLocks.ownerUserId, ownerUserId), eq(projectRunLocks.projectId, parsedProjectId)));
          } else {
            await tx.insert(projectRunLocks).values({ ownerUserId, projectId: parsedProjectId, runId: null, fencingToken, leaseExpiresAt: new Date(now.getTime() + leaseMs), heartbeatAt: now });
          }
          return { ownerUserId, projectId: parsedProjectId, fencingToken, leaseMs };
        });
      },

      async renewRestoreLock(identity: VerifiedIdentityContext, lock: { ownerUserId: string; projectId: string; fencingToken: number; leaseMs: number }) {
        const ownerUserId = await resolveOwnerId(db, identity);
        if (ownerUserId !== lock.ownerUserId) throw new StaleRunWorkerError();
        const now = new Date();
        const [updated] = await db.update(projectRunLocks).set({
          leaseExpiresAt: new Date(now.getTime() + lock.leaseMs), heartbeatAt: now, updatedAt: now,
        }).where(and(
          eq(projectRunLocks.ownerUserId, ownerUserId), eq(projectRunLocks.projectId, lock.projectId),
          isNull(projectRunLocks.runId), eq(projectRunLocks.fencingToken, lock.fencingToken),
          sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
        )).returning({ projectId: projectRunLocks.projectId });
        if (!updated) throw new StaleRunWorkerError();
      },

      async releaseRestoreLock(identity: VerifiedIdentityContext, lock: { ownerUserId: string; projectId: string; fencingToken: number }) {
        const ownerUserId = await resolveOwnerId(db, identity);
        if (ownerUserId !== lock.ownerUserId) throw new StaleRunWorkerError();
        await db.update(projectRunLocks).set({ leaseExpiresAt: null, heartbeatAt: new Date(), updatedAt: new Date() }).where(and(
          eq(projectRunLocks.ownerUserId, ownerUserId), eq(projectRunLocks.projectId, lock.projectId),
          isNull(projectRunLocks.runId), eq(projectRunLocks.fencingToken, lock.fencingToken),
        ));
      },

      async create(
        identity: VerifiedIdentityContext,
        input: z.input<typeof versionInputSchema>,
      ) {
        const parsed = versionInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        const id = parsed.versionId ?? randomUUID();
        return db.transaction(async (tx) => {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).for("update").limit(1);
          const [project] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false))))
            .for("update")
            .limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          await assertStorageCapacity(tx, ownerUserId, parsed.sizeBytes, parsed.storageLimitBytes ?? policy.maxStorageBytes);
          if (parsed.parentVersionId) {
            const [parent] = await tx.select({ id: versions.id }).from(versions).where(and(
              eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, parsed.projectId),
              eq(versions.id, parsed.parentVersionId), eq(versions.status, "ready"),
            )).limit(1);
            if (!parent) throw new OwnedResourceNotFoundError();
          }
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
              parentVersionId: parsed.parentVersionId ?? null,
              manifest: parsed.manifest ?? {},
              snapshotKey,
              sha256: parsed.sha256,
              sizeBytes: parsed.sizeBytes,
            })
            .returning();
          if (!version) throw new Error("No se pudo crear la versión");
          return version;
        });
      },

      async createRestored(
        identity: VerifiedIdentityContext,
        lock: { ownerUserId: string; projectId: string; fencingToken: number },
        input: z.input<typeof versionInputSchema>,
      ) {
        const parsed = versionInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        if (ownerUserId !== lock.ownerUserId || parsed.projectId !== lock.projectId) throw new StaleRunWorkerError();
        const id = parsed.versionId ?? randomUUID();
        return db.transaction(async (tx) => {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).for("update").limit(1);
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const now = new Date();
          const [activeLock] = await tx.select({ projectId: projectRunLocks.projectId }).from(projectRunLocks).where(and(
            eq(projectRunLocks.ownerUserId, ownerUserId), eq(projectRunLocks.projectId, parsed.projectId),
            isNull(projectRunLocks.runId), eq(projectRunLocks.fencingToken, lock.fencingToken),
            sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
          )).for("update").limit(1);
          if (!activeLock) throw new StaleRunWorkerError();
          const [activeRun] = await tx.select({ id: runs.id }).from(runs).where(and(
            eq(runs.ownerUserId, ownerUserId), eq(runs.projectId, parsed.projectId),
            inArray(runs.status, ["queued", "planning", "running", "verifying"]),
          )).limit(1);
          if (activeRun) throw new ProjectRunBusyError();
          await assertStorageCapacity(tx, ownerUserId, parsed.sizeBytes, parsed.storageLimitBytes ?? policy.maxStorageBytes);
          const parentVersionId = parsed.parentVersionId ?? null;
          if (parentVersionId) {
            const [parent] = await tx.select({ id: versions.id }).from(versions).where(and(
              eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, parsed.projectId),
              eq(versions.id, parentVersionId), eq(versions.status, "ready"),
            )).limit(1);
            if (!parent) throw new OwnedResourceNotFoundError();
          }
          const [next] = await tx.select({ value: sql<number>`coalesce(max(${versions.versionNumber}), 0) + 1` }).from(versions)
            .where(and(eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, parsed.projectId)));
          const [version] = await tx.insert(versions).values({
            id,
            ownerUserId,
            projectId: parsed.projectId,
            versionNumber: next?.value ?? 1,
            runId: null,
            parentVersionId,
            snapshotKey: `private/${ownerUserId}/projects/${parsed.projectId}/versions/${id}`,
            sha256: parsed.sha256,
            sizeBytes: parsed.sizeBytes,
            manifest: parsed.manifest ?? {},
            status: "creating",
          }).returning();
          if (!version) throw new Error("restore_version_reservation_failed");
          return version;
        });
      },

      async markRestoredSnapshotReady(
        identity: VerifiedIdentityContext,
        lock: { ownerUserId: string; projectId: string; fencingToken: number },
        versionId: string,
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedVersionId = uuidSchema.parse(versionId);
        if (ownerUserId !== lock.ownerUserId) throw new StaleRunWorkerError();
        return db.transaction(async (tx) => {
          const now = new Date();
          const [activeLock] = await tx.select({ projectId: projectRunLocks.projectId }).from(projectRunLocks).where(and(
            eq(projectRunLocks.ownerUserId, ownerUserId), eq(projectRunLocks.projectId, lock.projectId),
            isNull(projectRunLocks.runId), eq(projectRunLocks.fencingToken, lock.fencingToken),
            sql`${projectRunLocks.leaseExpiresAt} > ${now}`,
          )).for("update").limit(1);
          if (!activeLock) throw new StaleRunWorkerError();
          const [version] = await tx.update(versions).set({ status: "ready" }).where(and(
            eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, lock.projectId),
            eq(versions.id, parsedVersionId), eq(versions.status, "creating"),
          )).returning();
          if (!version) throw new OwnedResourceNotFoundError();
          return version;
        });
      },

      async getSnapshotCandidate(identity: VerifiedIdentityContext, projectId: string, versionId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [version] = await db.select().from(versions).where(and(
          eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, uuidSchema.parse(projectId)),
          eq(versions.id, uuidSchema.parse(versionId)),
        )).limit(1);
        return version;
      },

      async listSnapshotReconciliationCandidates(cutoff: Date, limit = 50) {
        if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 250) {
          throw new RangeError("Límites de reconciliación inválidos");
        }
        return db.select().from(versions).where(and(eq(versions.status, "creating"), lt(versions.createdAt, cutoff)))
          .orderBy(asc(versions.createdAt), asc(versions.id)).limit(limit);
      },

      async reconcileSnapshotCandidate(input: {
        id: string;
        ownerUserId: string;
        projectId: string;
        sha256: string;
        sizeBytes: number;
        createdAt: Date;
        cutoff: Date;
        status: "ready" | "failed";
      }) {
        const candidate = z.object({
          id: uuidSchema, ownerUserId: uuidSchema, projectId: uuidSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive(),
          createdAt: z.date(), cutoff: z.date(), status: z.enum(["ready", "failed"]),
        }).strict().parse(input);
        if (!Number.isFinite(candidate.createdAt.getTime()) || !Number.isFinite(candidate.cutoff.getTime())) throw new TypeError("Fecha de reconciliación inválida");
        const [updated] = await db.update(versions).set({ status: candidate.status }).where(and(
          eq(versions.id, candidate.id), eq(versions.ownerUserId, candidate.ownerUserId),
          eq(versions.projectId, candidate.projectId), eq(versions.status, "creating"),
          eq(versions.sha256, candidate.sha256), eq(versions.sizeBytes, candidate.sizeBytes),
          lt(versions.createdAt, candidate.cutoff),
        )).returning({ id: versions.id });
        return Boolean(updated);
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
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, candidate.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
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
              eq(versions.status, "ready"),
              or(
                lt(versions.createdAt, cursor.createdAt),
                and(eq(versions.createdAt, cursor.createdAt), lt(versions.id, cursor.id)),
              ),
            )
          : and(eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, parsedProjectId), eq(versions.status, "ready"));
        const rows = await db
          .select({
            id: versions.id,
            projectId: versions.projectId,
            versionNumber: versions.versionNumber,
            runId: versions.runId,
            parentVersionId: versions.parentVersionId,
            manifest: versions.manifest,
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
        input: { projectId: string; versionId: string; idempotencyKey?: string },
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const projectId = uuidSchema.parse(input.projectId);
        const versionId = uuidSchema.parse(input.versionId);
        const idempotencyKey = z.string().trim().min(8).max(128).parse(input.idempotencyKey ?? randomUUID());
        return db.transaction(async (tx) => {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).for("update").limit(1);
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [version] = await tx.select({ id: versions.id }).from(versions).where(and(
            eq(versions.ownerUserId, ownerUserId), eq(versions.projectId, projectId),
            eq(versions.id, versionId), eq(versions.status, "ready"),
          )).limit(1);
          if (!version) throw new OwnedResourceNotFoundError();
          const [existing] = await tx.select().from(publications).where(and(
            eq(publications.ownerUserId, ownerUserId),
            eq(publications.projectId, projectId),
            eq(publications.idempotencyKey, idempotencyKey),
          )).limit(1);
          if (existing) {
            if (existing.versionId !== versionId) throw new IdempotencyConflictError();
            return existing;
          }
          const id = randomUUID();
          const slug = randomUUID().replaceAll("-", "").slice(0, 20);
          const artifactKey = `published/${slug}`;
          const [publication] = await tx.insert(publications)
            .values({ id, ownerUserId, projectId, versionId, slug, artifactKey, idempotencyKey })
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
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, candidate.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [publication] = await tx.update(publications).set({
            status,
            updatedAt: new Date(),
            ...(status === "revoked" || status === "failed" ? { buildLeaseToken: null, buildLeaseExpiresAt: null } : {}),
          }).where(and(
            eq(publications.ownerUserId, ownerUserId), eq(publications.id, parsedPublicationId),
          )).returning();
          if (!publication) throw new OwnedResourceNotFoundError();
          return publication;
        });
      },

      async get(identity: VerifiedIdentityContext, projectId: string, publicationId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        const parsedPublicationId = uuidSchema.parse(publicationId);
        await assertOwnedProject(db, ownerUserId, parsedProjectId);
        const [publication] = await db.select().from(publications).where(and(
          eq(publications.ownerUserId, ownerUserId),
          eq(publications.projectId, parsedProjectId),
          eq(publications.id, parsedPublicationId),
        )).limit(1);
        return publication;
      },

      async claimBuild(identity: VerifiedIdentityContext, publicationId: string, leaseMs = 120_000) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedPublicationId = uuidSchema.parse(publicationId);
        const now = new Date();
        const token = randomUUID();
        const slug = randomUUID().replaceAll("-", "").slice(0, 20);
        return db.transaction(async (tx) => {
          const [candidate] = await tx.select({ projectId: publications.projectId }).from(publications).where(and(
            eq(publications.ownerUserId, ownerUserId), eq(publications.id, parsedPublicationId),
          )).limit(1);
          if (!candidate) throw new OwnedResourceNotFoundError();
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, candidate.projectId),
            and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          const [otherActiveBuild] = await tx.select({ id: publications.id }).from(publications).where(and(
            eq(publications.ownerUserId, ownerUserId),
            eq(publications.projectId, candidate.projectId),
            ne(publications.id, parsedPublicationId),
            eq(publications.status, "building"),
            gt(publications.buildLeaseExpiresAt, now),
          )).limit(1);
          if (otherActiveBuild) return undefined;
          const [publication] = await tx.update(publications).set({
            status: "building", slug, artifactKey: `published/${slug}`, buildLeaseToken: token,
            buildLeaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now,
          }).where(and(
            eq(publications.ownerUserId, ownerUserId),
            eq(publications.id, parsedPublicationId),
            or(
              eq(publications.status, "failed"),
              and(eq(publications.status, "building"), or(isNull(publications.buildLeaseExpiresAt), lt(publications.buildLeaseExpiresAt, now))),
            ),
          )).returning();
          return publication;
        });
      },

      async renewBuildLease(identity: VerifiedIdentityContext, publicationId: string, leaseToken: string, leaseMs = 120_000) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [publication] = await db.update(publications).set({
          buildLeaseExpiresAt: new Date(Date.now() + leaseMs), updatedAt: new Date(),
        }).where(and(
          eq(publications.ownerUserId, ownerUserId),
          eq(publications.id, uuidSchema.parse(publicationId)),
          eq(publications.status, "building"),
          eq(publications.buildLeaseToken, uuidSchema.parse(leaseToken)),
        )).returning();
        return publication;
      },

      async markPublished(identity: VerifiedIdentityContext, publicationId: string, leaseToken: string, input: {
        artifactSha256: string;
        manifest: Record<string, unknown>;
      }) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const sha = z.string().regex(/^[a-f0-9]{64}$/).parse(input.artifactSha256);
        const parsedManifest = z.record(z.string().max(512), z.unknown()).parse(input.manifest);
        const [publication] = await db.update(publications).set({
          status: "published", artifactSha256: sha, manifest: parsedManifest,
          buildLeaseToken: null, buildLeaseExpiresAt: null, updatedAt: new Date(),
        }).where(and(
          eq(publications.ownerUserId, ownerUserId),
          eq(publications.id, uuidSchema.parse(publicationId)),
          eq(publications.status, "building"),
          eq(publications.buildLeaseToken, uuidSchema.parse(leaseToken)),
        )).returning();
        return publication;
      },

      async markBuildFailed(identity: VerifiedIdentityContext, publicationId: string, leaseToken: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [publication] = await db.update(publications).set({
          status: "failed", buildLeaseToken: null, buildLeaseExpiresAt: null, updatedAt: new Date(),
        }).where(and(
          eq(publications.ownerUserId, ownerUserId),
          eq(publications.id, uuidSchema.parse(publicationId)),
          eq(publications.status, "building"),
          eq(publications.buildLeaseToken, uuidSchema.parse(leaseToken)),
        )).returning();
        return publication;
      },

      async getBySlug(slug: string) {
        const parsedSlug = z.string().regex(/^[a-f0-9]{20}$/).parse(slug);
        const [publication] = await db.select({
          id: publications.id,
          slug: publications.slug,
          artifactKey: publications.artifactKey,
          artifactSha256: publications.artifactSha256,
          manifest: publications.manifest,
          status: publications.status,
        }).from(publications).where(and(
          eq(publications.slug, parsedSlug), eq(publications.status, "published"),
        )).limit(1);
        return publication;
      },

      async getForCleanup(identity: VerifiedIdentityContext, publicationId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [publication] = await db.select().from(publications).where(and(
          eq(publications.ownerUserId, ownerUserId), eq(publications.id, uuidSchema.parse(publicationId)),
        )).limit(1);
        if (!publication) throw new OwnedResourceNotFoundError();
        return publication;
      },

      async listExpiredBuilds(cutoff: Date, limit = 50) {
        return db.select({ publication: publications, userId: users.userId }).from(publications)
          .innerJoin(users, eq(users.id, publications.ownerUserId)).where(and(
          eq(publications.status, "building"),
          or(isNull(publications.buildLeaseExpiresAt), lt(publications.buildLeaseExpiresAt, cutoff)),
        )).orderBy(asc(publications.updatedAt)).limit(Math.max(1, Math.min(100, Math.trunc(limit))));
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
              versionNumber: versions.versionNumber,
            slug: publications.slug,
            status: publications.status,
            idempotencyKey: publications.idempotencyKey,
            artifactSha256: publications.artifactSha256,
            manifest: publications.manifest,
            createdAt: publications.createdAt,
          })
          .from(publications)
            .innerJoin(versions, and(
              eq(versions.ownerUserId, publications.ownerUserId),
              eq(versions.projectId, publications.projectId),
              eq(versions.id, publications.versionId),
            ))
          .where(where)
          .orderBy(desc(publications.createdAt), desc(publications.id))
          .limit(limit + 1);
        return makePage(rows, limit);
      },
    },

    usage: {
      async getSummary(identity: VerifiedIdentityContext) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const dayStart = utcDayStart(new Date());
        const [projectsUsed] = await db.select({ count: sql<number>`count(*)` }).from(projects).where(and(
          eq(projects.ownerUserId, ownerUserId), isNull(projects.deletedAt), eq(projects.isInternal, false),
        ));
        const [activeRuns] = await db.select({ count: sql<number>`count(*)` }).from(runs).where(and(
          eq(runs.ownerUserId, ownerUserId), sql`${runs.status} in ('queued', 'planning', 'running', 'verifying')`,
        ));
        const [consumed] = await db.select({
          tokens: sql<number>`coalesce(sum(case when ${usageLedger.kind} = 'refund' then -${usageLedger.tokens} else ${usageLedger.tokens} end), 0)`,
          images: sql<number>`coalesce(sum(case when ${usageLedger.kind} = 'refund' then -${usageLedger.images} else ${usageLedger.images} end), 0)`,
        }).from(usageLedger).where(and(
          eq(usageLedger.ownerUserId, ownerUserId), sql`${usageLedger.createdAt} >= ${dayStart}`,
        ));
        const [held] = await db.select({
          tokens: sql<number>`coalesce(sum(${usageReservations.reservedTokens}), 0)`,
          images: sql<number>`coalesce(sum(${usageReservations.reservedImages}), 0)`,
          storage: sql<number>`coalesce(sum(${usageReservations.reservedStorageBytes}), 0)`,
        }).from(usageReservations).where(and(
          eq(usageReservations.ownerUserId, ownerUserId), eq(usageReservations.status, "reserved"),
        ));
        const [assetUsage] = await db.select({
          used: sql<number>`coalesce(sum(case when ${assets.status} = 'pending' then 0 else ${assets.sizeBytes} end), 0)`,
          reserved: sql<number>`coalesce(sum(case when ${assets.status} = 'pending' then ${assets.sizeBytes} else 0 end), 0)`,
        }).from(assets).where(eq(assets.ownerUserId, ownerUserId));
        const [snapshotUsage] = await db.select({
          used: sql<number>`coalesce(sum(case when ${versions.status} = 'creating' then 0 else ${versions.sizeBytes} end), 0)`,
          reserved: sql<number>`coalesce(sum(case when ${versions.status} = 'creating' then ${versions.sizeBytes} else 0 end), 0)`,
        }).from(versions).where(eq(versions.ownerUserId, ownerUserId));
        const [lifecycleUsage] = await db.select({ bytes: sql<number>`coalesce(sum(${sandboxes.lifecycleSnapshotSizeBytes}), 0)` })
          .from(sandboxes).where(eq(sandboxes.ownerUserId, ownerUserId));
        return {
          projects: { used: Number(projectsUsed?.count ?? 0), limit: policy.maxProjects },
          concurrency: { used: Number(activeRuns?.count ?? 0), limit: policy.maxConcurrentJobs },
          tokens: { used: Number(consumed?.tokens ?? 0), reserved: Number(held?.tokens ?? 0), limit: policy.dailyTokenLimit },
          images: { used: Number(consumed?.images ?? 0), reserved: Number(held?.images ?? 0), limit: policy.dailyImageLimit },
          storage: {
            usedBytes: Number(assetUsage?.used ?? 0) + Number(snapshotUsage?.used ?? 0) + Number(lifecycleUsage?.bytes ?? 0),
            reservedBytes: Number(assetUsage?.reserved ?? 0) + Number(snapshotUsage?.reserved ?? 0) + Number(held?.storage ?? 0),
            limitBytes: policy.maxStorageBytes,
          },
          run: { maxTokens: policy.runMaxTokens, maxDurationMs: policy.runMaxDurationMs },
          asOf: new Date().toISOString(),
        };
      },

      async reserve(identity: VerifiedIdentityContext, input: z.input<typeof usageInputSchema>) {
        const parsed = usageInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        return db.transaction(async (tx) => {
          await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).for("update").limit(1);
          const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
          )).for("update").limit(1);
          if (!project) throw new OwnedResourceNotFoundError();
          if (parsed.reservedStorageBytes) await assertStorageCapacity(tx, ownerUserId, parsed.reservedStorageBytes);
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
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, candidate.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
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
            eq(projects.ownerUserId, ownerUserId), eq(projects.id, reservation.projectId), and(isNull(projects.deletedAt), eq(projects.isInternal, false)),
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
