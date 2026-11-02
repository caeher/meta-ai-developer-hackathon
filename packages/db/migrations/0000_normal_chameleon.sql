CREATE TYPE "public"."asset_status" AS ENUM('pending', 'ready', 'delete_requested', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('building', 'published', 'revoked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('reserved', 'committed', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'planning', 'running', 'verifying', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sandbox_status" AS ENUM('provisioning', 'ready', 'stopping', 'stopped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('charge', 'refund', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('creating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"object_key" varchar(700) NOT NULL,
	"content_type" varchar(150) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"status" "asset_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "assets_owner_project_id_unique" UNIQUE("owner_user_id","project_id","id"),
	CONSTRAINT "assets_size_positive_check" CHECK ("assets"."size_bytes" > 0),
	CONSTRAINT "assets_sha256_format_check" CHECK ("assets"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_owner_id_id_unique" UNIQUE("owner_user_id","id"),
	CONSTRAINT "projects_name_nonempty_check" CHECK (length(trim("projects"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"slug" varchar(100) NOT NULL,
	"artifact_key" varchar(700) NOT NULL,
	"status" "publication_status" DEFAULT 'building' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_slug_unique" UNIQUE("slug"),
	CONSTRAINT "publications_artifact_key_unique" UNIQUE("artifact_key"),
	CONSTRAINT "publications_owner_project_id_unique" UNIQUE("owner_user_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_sequence_unique" UNIQUE("owner_user_id","run_id","sequence"),
	CONSTRAINT "run_events_sequence_positive_check" CHECK ("run_events"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"plan" jsonb,
	"error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_owner_project_id_unique" UNIQUE("owner_user_id","project_id","id"),
	CONSTRAINT "runs_owner_idempotency_unique" UNIQUE("owner_user_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"runtime_id" varchar(255),
	"status" "sandbox_status" DEFAULT 'provisioning' NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_owner_project_unique" UNIQUE("owner_user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"kind" "usage_kind" NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"storage_bytes" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_ledger_owner_idempotency_unique" UNIQUE("owner_user_id","idempotency_key"),
	CONSTRAINT "usage_ledger_tokens_nonnegative_check" CHECK ("usage_ledger"."tokens" >= 0),
	CONSTRAINT "usage_ledger_images_nonnegative_check" CHECK ("usage_ledger"."images" >= 0),
	CONSTRAINT "usage_ledger_storage_nonnegative_check" CHECK ("usage_ledger"."storage_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"reserved_tokens" integer DEFAULT 0 NOT NULL,
	"reserved_images" integer DEFAULT 0 NOT NULL,
	"reserved_storage_bytes" bigint DEFAULT 0 NOT NULL,
	"status" "reservation_status" DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_reservations_owner_project_id_unique" UNIQUE("owner_user_id","project_id","id"),
	CONSTRAINT "usage_reservations_owner_idempotency_unique" UNIQUE("owner_user_id","idempotency_key"),
	CONSTRAINT "usage_reservations_tokens_nonnegative_check" CHECK ("usage_reservations"."reserved_tokens" >= 0),
	CONSTRAINT "usage_reservations_images_nonnegative_check" CHECK ("usage_reservations"."reserved_images" >= 0),
	CONSTRAINT "usage_reservations_storage_nonnegative_check" CHECK ("usage_reservations"."reserved_storage_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"snapshot_key" varchar(700) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" "version_status" DEFAULT 'creating' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "versions_snapshot_key_unique" UNIQUE("snapshot_key"),
	CONSTRAINT "versions_owner_project_id_unique" UNIQUE("owner_user_id","project_id","id"),
	CONSTRAINT "versions_project_number_unique" UNIQUE("owner_user_id","project_id","version_number"),
	CONSTRAINT "versions_number_positive_check" CHECK ("versions"."version_number" > 0),
	CONSTRAINT "versions_size_nonnegative_check" CHECK ("versions"."size_bytes" >= 0),
	CONSTRAINT "versions_sha256_format_check" CHECK ("versions"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_project_run_fk" FOREIGN KEY ("owner_user_id","project_id","run_id") REFERENCES "public"."runs"("owner_user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_owner_project_version_fk" FOREIGN KEY ("owner_user_id","project_id","version_id") REFERENCES "public"."versions"("owner_user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_owner_project_run_fk" FOREIGN KEY ("owner_user_id","project_id","run_id") REFERENCES "public"."runs"("owner_user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_owner_project_reservation_fk" FOREIGN KEY ("owner_user_id","project_id","reservation_id") REFERENCES "public"."usage_reservations"("owner_user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_owner_project_created_idx" ON "assets" USING btree ("owner_user_id","project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "assets_owner_status_idx" ON "assets" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "messages_owner_project_created_idx" ON "messages" USING btree ("owner_user_id","project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "projects_owner_created_idx" ON "projects" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "publications_owner_project_created_idx" ON "publications" USING btree ("owner_user_id","project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "run_events_owner_run_created_idx" ON "run_events" USING btree ("owner_user_id","project_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_owner_project_created_idx" ON "runs" USING btree ("owner_user_id","project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "runs_owner_status_created_idx" ON "runs" USING btree ("owner_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sandboxes_owner_status_idx" ON "sandboxes" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "usage_ledger_owner_project_created_idx" ON "usage_ledger" USING btree ("owner_user_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_reservations_owner_status_expires_idx" ON "usage_reservations" USING btree ("owner_user_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "versions_owner_project_created_idx" ON "versions" USING btree ("owner_user_id","project_id","created_at","id");