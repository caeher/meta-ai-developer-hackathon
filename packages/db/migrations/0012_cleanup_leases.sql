ALTER TABLE "project_cleanup_tasks" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "project_cleanup_tasks" ADD COLUMN "lease_expires_at" timestamp with time zone;