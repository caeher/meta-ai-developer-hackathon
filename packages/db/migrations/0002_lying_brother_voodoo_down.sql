DROP TABLE "project_cleanup_tasks";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_owner_project_request_unique";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_owner_project_sequence_unique";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_sequence_positive_check";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "request_id";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "sequence";--> statement-breakpoint
DROP INDEX "projects_owner_active_created_idx";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "deleted_at";--> statement-breakpoint
DROP TYPE "public"."cleanup_status";--> statement-breakpoint
ALTER TYPE "public"."version_status" RENAME TO "version_status_with_delete_requested";--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('creating', 'ready', 'failed');--> statement-breakpoint
ALTER TABLE "versions" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "versions" ALTER COLUMN "status" TYPE "public"."version_status" USING ("status"::text::"public"."version_status");--> statement-breakpoint
ALTER TABLE "versions" ALTER COLUMN "status" SET DEFAULT 'creating';--> statement-breakpoint
DROP TYPE "public"."version_status_with_delete_requested";
