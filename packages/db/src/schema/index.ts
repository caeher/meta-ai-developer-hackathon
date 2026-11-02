import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow();

export const messageRole = pgEnum("message_role", ["user", "assistant", "tool"]);
export const runStatus = pgEnum("run_status", [
  "queued",
  "planning",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);
export const sandboxStatus = pgEnum("sandbox_status", [
  "provisioning",
  "ready",
  "stopping",
  "stopped",
  "failed",
]);
export const assetStatus = pgEnum("asset_status", [
  "pending",
  "ready",
  "delete_requested",
  "failed",
]);
export const versionStatus = pgEnum("version_status", ["creating", "ready", "failed", "delete_requested"]);
export const publicationStatus = pgEnum("publication_status", [
  "building",
  "published",
  "revoked",
  "failed",
]);
export const reservationStatus = pgEnum("reservation_status", [
  "reserved",
  "committed",
  "released",
  "expired",
]);
export const usageKind = pgEnum("usage_kind", ["charge", "refund", "adjustment"]);
export const cleanupStatus = pgEnum("cleanup_status", ["queued", "running", "succeeded", "failed"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clerkUserId: varchar("clerk_user_id", { length: 255 }).notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("users_created_at_idx").on(table.createdAt)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("projects_owner_id_id_unique").on(table.ownerUserId, table.id),
    index("projects_owner_created_idx").on(table.ownerUserId, table.createdAt, table.id),
    index("projects_owner_active_created_idx").on(table.ownerUserId, table.deletedAt, table.createdAt, table.id),
    check("projects_name_nonempty_check", sql`length(trim(${table.name})) > 0`),
  ],
);

export const projectCleanupTasks = pgTable(
  "project_cleanup_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    status: cleanupStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "project_cleanup_tasks_owner_project_fk",
      columns: [table.ownerUserId, table.projectId],
      foreignColumns: [projects.ownerUserId, projects.id],
    }).onDelete("cascade"),
    unique("project_cleanup_tasks_owner_project_unique").on(table.ownerUserId, table.projectId),
    index("project_cleanup_tasks_status_created_idx").on(table.status, table.createdAt),
    check("project_cleanup_tasks_attempts_nonnegative_check", sql`${table.attempts} >= 0`),
  ],
);
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    status: runStatus("status").notNull().default("queued"),
    plan: jsonb("plan").$type<Record<string, unknown> | null>(),
    errorCode: varchar("error_code", { length: 100 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "runs_owner_project_fk",
      columns: [table.ownerUserId, table.projectId],
      foreignColumns: [projects.ownerUserId, projects.id],
    }).onDelete("cascade"),
    unique("runs_owner_project_id_unique").on(table.ownerUserId, table.projectId, table.id),
    unique("runs_owner_idempotency_unique").on(table.ownerUserId, table.idempotencyKey),
    index("runs_owner_project_created_idx").on(
      table.ownerUserId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
    index("runs_owner_status_created_idx").on(table.ownerUserId, table.status, table.createdAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id"),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    requestId: varchar("request_id", { length: 128 }).notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "messages_owner_project_fk",
      columns: [table.ownerUserId, table.projectId],
      foreignColumns: [projects.ownerUserId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "messages_owner_project_run_fk",
      columns: [table.ownerUserId, table.projectId, table.runId],
      foreignColumns: [runs.ownerUserId, runs.projectId, runs.id],
    }).onDelete("cascade"),
    index("messages_owner_project_created_idx").on(
      table.ownerUserId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
    unique("messages_owner_project_request_unique").on(table.ownerUserId, table.projectId, table.requestId),
    unique("messages_owner_project_sequence_unique").on(table.ownerUserId, table.projectId, table.sequence),
    check("messages_sequence_positive_check", sql`${table.sequence} > 0`),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    type: varchar("type", { length: 100 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "run_events_owner_project_run_fk",
      columns: [table.ownerUserId, table.projectId, table.runId],
      foreignColumns: [runs.ownerUserId, runs.projectId, runs.id],
    }).onDelete("cascade"),
    unique("run_events_run_sequence_unique").on(table.ownerUserId, table.runId, table.sequence),
    index("run_events_owner_run_created_idx").on(
      table.ownerUserId,
      table.projectId,
      table.runId,
      table.createdAt,
    ),
    check("run_events_sequence_positive_check", sql`${table.sequence} > 0`),
  ],
);

export const sandboxes = pgTable(
  "sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    runtimeId: varchar("runtime_id", { length: 255 }),
    status: sandboxStatus("status").notNull().default("provisioning"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "sandboxes_owner_project_fk",
      columns: [table.ownerUserId, table.projectId],
      foreignColumns: [projects.ownerUserId, projects.id],
    }).onDelete("cascade"),
    unique("sandboxes_owner_project_unique").on(table.ownerUserId, table.projectId),
    index("sandboxes_owner_status_idx").on(table.ownerUserId, table.status),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    objectKey: varchar("object_key", { length: 700 }).notNull().unique(),
    contentType: varchar("content_type", { length: 150 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    status: assetStatus("status").notNull().default("pending"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "assets_owner_project_fk",
      columns: [table.ownerUserId, table.projectId],
      foreignColumns: [projects.ownerUserId, projects.id],
    }).onDelete("cascade"),
    unique("assets_owner_project_id_unique").on(table.ownerUserId, table.projectId, table.id),
    index("assets_owner_project_created_idx").on(
      table.ownerUserId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
    index("assets_owner_status_idx").on(table.ownerUserId, table.status),
    check("assets_size_positive_check", sql`${table.sizeBytes} > 0`),
    check("assets_sha256_format_check", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const versions = pgTable(
  "versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    snapshotKey: varchar("snapshot_key", { length: 700 }).notNull().unique(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: versionStatus("status").notNull().default("creating"),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "versions_owner_project_fk",
      columns: [table.ownerUserId, table.projectId],
      foreignColumns: [projects.ownerUserId, projects.id],
    }).onDelete("cascade"),
    unique("versions_owner_project_id_unique").on(table.ownerUserId, table.projectId, table.id),
    unique("versions_project_number_unique").on(table.ownerUserId, table.projectId, table.versionNumber),
    index("versions_owner_project_created_idx").on(
      table.ownerUserId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
    check("versions_number_positive_check", sql`${table.versionNumber} > 0`),
    check("versions_size_nonnegative_check", sql`${table.sizeBytes} >= 0`),
    check("versions_sha256_format_check", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
  ],
);

export const publications = pgTable(
  "publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    versionId: uuid("version_id").notNull(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    artifactKey: varchar("artifact_key", { length: 700 }).notNull().unique(),
    status: publicationStatus("status").notNull().default("building"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "publications_owner_project_version_fk",
      columns: [table.ownerUserId, table.projectId, table.versionId],
      foreignColumns: [versions.ownerUserId, versions.projectId, versions.id],
    }).onDelete("cascade"),
    unique("publications_owner_project_id_unique").on(
      table.ownerUserId,
      table.projectId,
      table.id,
    ),
    index("publications_owner_project_created_idx").on(
      table.ownerUserId,
      table.projectId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const usageReservations = pgTable(
  "usage_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    reservedTokens: integer("reserved_tokens").notNull().default(0),
    reservedImages: integer("reserved_images").notNull().default(0),
    reservedStorageBytes: bigint("reserved_storage_bytes", { mode: "number" })
      .notNull()
      .default(0),
    status: reservationStatus("status").notNull().default("reserved"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "usage_reservations_owner_project_fk",
      columns: [table.ownerUserId, table.projectId],
      foreignColumns: [projects.ownerUserId, projects.id],
    }).onDelete("cascade"),
    unique("usage_reservations_owner_project_id_unique").on(
      table.ownerUserId,
      table.projectId,
      table.id,
    ),
    unique("usage_reservations_owner_idempotency_unique").on(
      table.ownerUserId,
      table.idempotencyKey,
    ),
    index("usage_reservations_owner_status_expires_idx").on(
      table.ownerUserId,
      table.status,
      table.expiresAt,
    ),
    check("usage_reservations_tokens_nonnegative_check", sql`${table.reservedTokens} >= 0`),
    check("usage_reservations_images_nonnegative_check", sql`${table.reservedImages} >= 0`),
    check(
      "usage_reservations_storage_nonnegative_check",
      sql`${table.reservedStorageBytes} >= 0`,
    ),
  ],
);

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    kind: usageKind("kind").notNull(),
    tokens: integer("tokens").notNull().default(0),
    images: integer("images").notNull().default(0),
    storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "usage_ledger_owner_project_reservation_fk",
      columns: [table.ownerUserId, table.projectId, table.reservationId],
      foreignColumns: [
        usageReservations.ownerUserId,
        usageReservations.projectId,
        usageReservations.id,
      ],
    }).onDelete("cascade"),
    unique("usage_ledger_owner_idempotency_unique").on(table.ownerUserId, table.idempotencyKey),
    index("usage_ledger_owner_project_created_idx").on(
      table.ownerUserId,
      table.projectId,
      table.createdAt,
    ),
    check("usage_ledger_tokens_nonnegative_check", sql`${table.tokens} >= 0`),
    check("usage_ledger_images_nonnegative_check", sql`${table.images} >= 0`),
    check("usage_ledger_storage_nonnegative_check", sql`${table.storageBytes} >= 0`),
  ],
);
