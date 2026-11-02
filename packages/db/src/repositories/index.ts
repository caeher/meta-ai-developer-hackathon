import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { GameDatabase } from "../database";
import {
  assertVerifiedIdentityContext,
  IdempotencyConflictError,
  OwnedResourceNotFoundError,
  type VerifiedIdentityContext,
} from "../identity";
import {
  assets,
  messages,
  projects,
  publications,
  runEvents,
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
  runId: uuidSchema.optional(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().min(1).max(100_000),
});
const runInputSchema = z.object({
  projectId: uuidSchema,
  idempotencyKey: z.string().min(8).max(128),
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
    .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, projectId)))
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
          .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsedProjectId)))
          .limit(1);
        return project;
      },

      async rename(identity: VerifiedIdentityContext, projectId: string, name: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedProjectId = uuidSchema.parse(projectId);
        const [project] = await db
          .update(projects)
          .set({ name: projectNameSchema.parse(name), updatedAt: new Date() })
          .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsedProjectId)))
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
              or(
                lt(projects.createdAt, cursor.createdAt),
                and(eq(projects.createdAt, cursor.createdAt), lt(projects.id, cursor.id)),
              ),
            )
          : eq(projects.ownerUserId, ownerUserId);
        const rows = await db
          .select()
          .from(projects)
          .where(where)
          .orderBy(desc(projects.createdAt), desc(projects.id))
          .limit(limit + 1);
        return makePage(rows, limit);
      },
    },

    messages: {
      async create(identity: VerifiedIdentityContext, input: z.input<typeof messageInputSchema>) {
        const parsed = messageInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        await assertOwnedProject(db, ownerUserId, parsed.projectId);
        if (parsed.runId) {
          const [run] = await db
            .select({ id: runs.id })
            .from(runs)
            .where(
              and(
                eq(runs.ownerUserId, ownerUserId),
                eq(runs.projectId, parsed.projectId),
                eq(runs.id, parsed.runId),
              ),
            )
            .limit(1);
          if (!run) throw new OwnedResourceNotFoundError();
        }
        const [message] = await db
          .insert(messages)
          .values({ ...parsed, ownerUserId, runId: parsed.runId ?? null })
          .returning();
        if (!message) throw new Error("No se pudo crear el mensaje");
        return message;
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
              eq(messages.ownerUserId, ownerUserId),
              eq(messages.projectId, parsedProjectId),
              or(
                lt(messages.createdAt, cursor.createdAt),
                and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
              ),
            )
          : and(eq(messages.ownerUserId, ownerUserId), eq(messages.projectId, parsedProjectId));
        const rows = await db
          .select()
          .from(messages)
          .where(where)
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(limit + 1);
        return makePage(rows, limit);
      },
    },

    runs: {
      async create(identity: VerifiedIdentityContext, input: z.input<typeof runInputSchema>) {
        const parsed = runInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        await assertOwnedProject(db, ownerUserId, parsed.projectId);
        const [inserted] = await db
          .insert(runs)
          .values({
            ownerUserId,
            projectId: parsed.projectId,
            idempotencyKey: parsed.idempotencyKey,
          })
          .onConflictDoNothing({ target: [runs.ownerUserId, runs.idempotencyKey] })
          .returning();
        if (inserted) return inserted;
        const [existing] = await db
          .select()
          .from(runs)
          .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.idempotencyKey, parsed.idempotencyKey)))
          .limit(1);
        if (!existing) throw new Error("No se pudo reconciliar la clave de idempotencia");
        if (existing.projectId !== parsed.projectId) throw new IdempotencyConflictError();
        return existing;
      },

      async get(identity: VerifiedIdentityContext, runId: string) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedRunId = uuidSchema.parse(runId);
        const [run] = await db
          .select()
          .from(runs)
          .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId)))
          .limit(1);
        return run;
      },

      async setStatus(
        identity: VerifiedIdentityContext,
        runId: string,
        status: "queued" | "planning" | "running" | "verifying" | "succeeded" | "failed" | "cancelled",
        errorCode?: string,
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [run] = await db
          .update(runs)
          .set({ status, errorCode: errorCode ?? null, updatedAt: new Date() })
          .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, uuidSchema.parse(runId))))
          .returning();
        if (!run) throw new OwnedResourceNotFoundError();
        return run;
      },

      async appendEvent(identity: VerifiedIdentityContext, runId: string, input: z.input<typeof runEventInputSchema>) {
        const parsed = runEventInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        const parsedRunId = uuidSchema.parse(runId);
        return db.transaction(async (tx) => {
          const [run] = await tx
            .select({ id: runs.id, projectId: runs.projectId })
            .from(runs)
            .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId)))
            .for("update")
            .limit(1);
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
          .where(and(eq(runs.ownerUserId, ownerUserId), eq(runs.id, parsedRunId)))
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
        await assertOwnedProject(db, ownerUserId, projectId);
        const [sandbox] = await db
          .insert(sandboxes)
          .values({
            ownerUserId,
            projectId,
            runtimeId: input.runtimeId ?? null,
            status: input.status,
            leaseExpiresAt: input.leaseExpiresAt ?? null,
          })
          .onConflictDoUpdate({
            target: [sandboxes.ownerUserId, sandboxes.projectId],
            set: {
              runtimeId: input.runtimeId ?? null,
              status: input.status,
              leaseExpiresAt: input.leaseExpiresAt ?? null,
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!sandbox) throw new Error("No se pudo guardar el sandbox");
        return sandbox;
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
        await assertOwnedProject(db, ownerUserId, parsed.projectId);
        const id = randomUUID();
        const objectKey = `private/${ownerUserId}/projects/${parsed.projectId}/assets/${id}`;
        const [asset] = await db
          .insert(assets)
          .values({ id, ownerUserId, objectKey, status: "pending", ...parsed })
          .returning();
        if (!asset) throw new Error("No se pudo reservar el asset");
        return asset;
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
            .where(and(eq(projects.ownerUserId, ownerUserId), eq(projects.id, parsed.projectId)))
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
        const [version] = await db
          .update(versions)
          .set({ status })
          .where(and(eq(versions.ownerUserId, ownerUserId), eq(versions.id, uuidSchema.parse(versionId))))
          .returning();
        if (!version) throw new OwnedResourceNotFoundError();
        return version;
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
        const [version] = await db
          .select({ id: versions.id })
          .from(versions)
          .where(
            and(
              eq(versions.ownerUserId, ownerUserId),
              eq(versions.projectId, projectId),
              eq(versions.id, versionId),
              eq(versions.status, "ready"),
            ),
          )
          .limit(1);
        if (!version) throw new OwnedResourceNotFoundError();
        const id = randomUUID();
        const slug = randomUUID().replaceAll("-", "").slice(0, 20);
        const artifactKey = `published/${ownerUserId}/projects/${projectId}/${id}`;
        const [publication] = await db
          .insert(publications)
          .values({ id, ownerUserId, projectId, versionId, slug, artifactKey })
          .returning();
        if (!publication) throw new Error("No se pudo crear la publicación");
        return publication;
      },

      async setStatus(
        identity: VerifiedIdentityContext,
        publicationId: string,
        status: "building" | "published" | "revoked" | "failed",
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [publication] = await db
          .update(publications)
          .set({ status, updatedAt: new Date() })
          .where(
            and(
              eq(publications.ownerUserId, ownerUserId),
              eq(publications.id, uuidSchema.parse(publicationId)),
            ),
          )
          .returning();
        if (!publication) throw new OwnedResourceNotFoundError();
        return publication;
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
        await assertOwnedProject(db, ownerUserId, parsed.projectId);
        const [inserted] = await db
          .insert(usageReservations)
          .values({ ...parsed, ownerUserId })
          .onConflictDoNothing({ target: [usageReservations.ownerUserId, usageReservations.idempotencyKey] })
          .returning();
        if (inserted) return inserted;
        const [existing] = await db
          .select()
          .from(usageReservations)
          .where(
            and(
              eq(usageReservations.ownerUserId, ownerUserId),
              eq(usageReservations.idempotencyKey, parsed.idempotencyKey),
            ),
          )
          .limit(1);
        if (!existing) throw new Error("No se pudo reconciliar la reserva de uso");
        if (existing.projectId !== parsed.projectId) throw new IdempotencyConflictError();
        return existing;
      },

      async setReservationStatus(
        identity: VerifiedIdentityContext,
        reservationId: string,
        status: "reserved" | "committed" | "released" | "expired",
      ) {
        const ownerUserId = await resolveOwnerId(db, identity);
        const [reservation] = await db
          .update(usageReservations)
          .set({ status, updatedAt: new Date() })
          .where(
            and(
              eq(usageReservations.ownerUserId, ownerUserId),
              eq(usageReservations.id, uuidSchema.parse(reservationId)),
            ),
          )
          .returning();
        if (!reservation) throw new OwnedResourceNotFoundError();
        return reservation;
      },

      async record(identity: VerifiedIdentityContext, input: z.input<typeof ledgerInputSchema>) {
        const parsed = ledgerInputSchema.parse(input);
        const ownerUserId = await resolveOwnerId(db, identity);
        const [reservation] = await db
          .select({ id: usageReservations.id, projectId: usageReservations.projectId })
          .from(usageReservations)
          .where(
            and(
              eq(usageReservations.ownerUserId, ownerUserId),
              eq(usageReservations.id, parsed.reservationId),
            ),
          )
          .limit(1);
        if (!reservation) throw new OwnedResourceNotFoundError();
        const [inserted] = await db
          .insert(usageLedger)
          .values({ ...parsed, ownerUserId, projectId: reservation.projectId })
          .onConflictDoNothing({ target: [usageLedger.ownerUserId, usageLedger.idempotencyKey] })
          .returning();
        if (inserted) return inserted;
        const [existing] = await db
          .select()
          .from(usageLedger)
          .where(
            and(
              eq(usageLedger.ownerUserId, ownerUserId),
              eq(usageLedger.idempotencyKey, parsed.idempotencyKey),
            ),
          )
          .limit(1);
        if (!existing) throw new Error("No se pudo reconciliar el asiento de uso");
        if (
          existing.projectId !== reservation.projectId ||
          existing.reservationId !== reservation.id
        ) {
          throw new IdempotencyConflictError();
        }
        return existing;
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
