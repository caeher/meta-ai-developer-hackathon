CREATE TYPE "public"."cleanup_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
ALTER TYPE "public"."version_status" ADD VALUE 'delete_requested';--> statement-breakpoint
CREATE TABLE "project_cleanup_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"status" "cleanup_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "project_cleanup_tasks_owner_project_unique" UNIQUE("owner_user_id","project_id"),
	CONSTRAINT "project_cleanup_tasks_attempts_nonnegative_check" CHECK ("project_cleanup_tasks"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "request_id" varchar(128);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sequence" integer;--> statement-breakpoint
UPDATE "messages" SET "request_id" = "id"::text;--> statement-breakpoint
WITH ordered_messages AS (
	SELECT "id", row_number() OVER (PARTITION BY "owner_user_id", "project_id" ORDER BY "created_at", "id")::integer AS "sequence"
	FROM "messages"
)
UPDATE "messages" AS target SET "sequence" = ordered_messages."sequence"
FROM ordered_messages WHERE target."id" = ordered_messages."id";--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_cleanup_tasks" ADD CONSTRAINT "project_cleanup_tasks_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_cleanup_tasks_status_created_idx" ON "project_cleanup_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "projects_owner_active_created_idx" ON "projects" USING btree ("owner_user_id","deleted_at","created_at","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_project_request_unique" UNIQUE("owner_user_id","project_id","request_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_project_sequence_unique" UNIQUE("owner_user_id","project_id","sequence");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sequence_positive_check" CHECK ("messages"."sequence" > 0);
