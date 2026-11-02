import {
  bigint,
  boolean,
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
  uniqueIndex,
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
export const outboxStatus = pgEnum("outbox_status", ["pending", "dispatching", "dispatched"]);
export const authTokenPurpose = pgEnum("auth_token_purpose", ["verify_email", "reset_password"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 255 }).notNull().unique(),
    email: varchar("email", { length: 320 }).unique(),
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("users_created_at_idx").on(table.createdAt),
    check("users_email_lowercase_check", sql`${table.email} is null or ${table.email} = lower(${table.email})`),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
    userRowId: uuid("user_row_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("auth_sessions_user_active_idx").on(table.userRowId, table.revokedAt, table.expiresAt),
    check("auth_sessions_expiry_order_check", sql`${table.expiresAt} <= ${table.absoluteExpiresAt}`),
  ],
);

export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userRowId: uuid("user_row_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    purpose: authTokenPurpose("purpose").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("auth_tokens_user_purpose_idx").on(table.userRowId, table.purpose, table.expiresAt),
    index("auth_tokens_expiry_idx").on(table.expiresAt),
  ],
);

export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    bucketHash: varchar("bucket_hash", { length: 64 }).primaryKey(),
    failures: integer("failures").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [check("auth_rate_limits_failures_nonnegative_check", sql`${table.failures} >= 0`)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
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
    contributorConsent: boolean("contributor_consent").notNull().default(false),
    errorCode: varchar("error_code", { length: 100 }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
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

export const projectRunLocks = pgTable(
  "project_run_locks",
  {
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id"),
    fencingToken: bigint("fencing_token", { mode: "number" }).notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("project_run_locks_owner_project_unique").on(table.ownerUserId, table.projectId),
    foreignKey({
      name: "project_run_locks_owner_project_fk",
      columns: [table.ownerUserId, table.projectId],
      foreignColumns: [projects.ownerUserId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "project_run_locks_owner_project_run_fk",
      columns: [table.ownerUserId, table.projectId, table.runId],
      foreignColumns: [runs.ownerUserId, runs.projectId, runs.id],
    }).onDelete("cascade"),
    index("project_run_locks_lease_idx").on(table.leaseExpiresAt),
    check("project_run_locks_fencing_nonnegative_check", sql`${table.fencingToken} >= 0`),
  ],
);

export const runOutbox = pgTable(
  "run_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id").notNull().unique(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    generation: integer("generation").notNull().default(0),
    status: outboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 100 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "run_outbox_owner_project_run_fk",
      columns: [table.ownerUserId, table.projectId, table.runId],
      foreignColumns: [runs.ownerUserId, runs.projectId, runs.id],
    }).onDelete("cascade"),
    index("run_outbox_status_created_idx").on(table.status, table.createdAt),
    check("run_outbox_generation_nonnegative_check", sql`${table.generation} >= 0`),
    check("run_outbox_attempts_nonnegative_check", sql`${table.attempts} >= 0`),
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
    runtimeUid: integer("runtime_uid").notNull().default(sql`nextval('sandboxes_runtime_uid_seq')`),
    status: sandboxStatus("status").notNull().default("provisioning"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    devServerStatus: varchar("dev_server_status", { length: 16 }).notNull().default("stopped"),
    devServerPort: integer("dev_server_port"),
    devServerLeaseExpiresAt: timestamp("dev_server_lease_expires_at", { withTimezone: true }),
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
    unique("sandboxes_runtime_uid_unique").on(table.runtimeUid),
    index("sandboxes_owner_status_idx").on(table.ownerUserId, table.status),
    check("sandboxes_runtime_uid_range_check", sql`${table.runtimeUid} between 10000 and 59999`),
    check("sandboxes_dev_server_status_check", sql`${table.devServerStatus} in ('stopped', 'starting', 'ready', 'failed')`),
    check("sandboxes_dev_server_port_check", sql`${table.devServerPort} is null or ${table.devServerPort} between 1024 and 65535`),
    check("sandboxes_dev_server_ready_check", sql`(${table.devServerStatus} in ('starting', 'ready')) = (${table.devServerPort} is not null and ${table.devServerLeaseExpiresAt} is not null)`),
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
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
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
    runId: uuid("run_id"),
    parentVersionId: uuid("parent_version_id"),
    snapshotKey: varchar("snapshot_key", { length: 700 }).notNull().unique(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
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
    uniqueIndex("versions_owner_project_run_unique").on(table.ownerUserId, table.projectId, table.runId).where(sql`${table.runId} is not null`),
    foreignKey({
      name: "versions_owner_project_run_fk",
      columns: [table.ownerUserId, table.projectId, table.runId],
      foreignColumns: [runs.ownerUserId, runs.projectId, runs.id],
    }).onDelete("cascade"),
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
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    artifactSha256: varchar("artifact_sha256", { length: 64 }),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    buildLeaseToken: uuid("build_lease_token"),
    buildLeaseExpiresAt: timestamp("build_lease_expires_at", { withTimezone: true }),
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
    uniqueIndex("publications_owner_project_idempotency_unique")
      .on(table.ownerUserId, table.projectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index("publications_build_lease_idx").on(table.status, table.buildLeaseExpiresAt),
    check("publications_artifact_sha256_format_check", sql`${table.artifactSha256} is null or ${table.artifactSha256} ~ '^[a-f0-9]{64}$'`),
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
    runId: uuid("run_id"),
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
    foreignKey({
      name: "usage_reservations_owner_project_run_fk",
      columns: [table.ownerUserId, table.projectId, table.runId],
      foreignColumns: [runs.ownerUserId, runs.projectId, runs.id],
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
    unique("usage_reservations_run_id_unique").on(table.runId),
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
