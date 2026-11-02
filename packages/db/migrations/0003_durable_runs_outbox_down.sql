DROP TABLE "run_outbox";--> statement-breakpoint
DROP TABLE "project_run_locks";--> statement-breakpoint
ALTER TABLE "usage_reservations" DROP CONSTRAINT "usage_reservations_owner_project_run_fk";--> statement-breakpoint
ALTER TABLE "usage_reservations" DROP CONSTRAINT "usage_reservations_run_id_unique";--> statement-breakpoint
ALTER TABLE "usage_reservations" DROP COLUMN "run_id";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "cancel_requested_at";--> statement-breakpoint
DROP TYPE "public"."outbox_status";
