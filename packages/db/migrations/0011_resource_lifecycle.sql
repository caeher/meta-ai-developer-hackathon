ALTER TYPE "public"."sandbox_status" ADD VALUE 'suspending' BEFORE 'stopping';--> statement-breakpoint
ALTER TYPE "public"."sandbox_status" ADD VALUE 'suspended' BEFORE 'stopping';--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "lifecycle_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "lifecycle_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "lifecycle_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "lifecycle_snapshot_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "lifecycle_snapshot_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_lifecycle_snapshot_metadata_check" CHECK (("sandboxes"."lifecycle_snapshot_id" is null and "sandboxes"."lifecycle_snapshot_sha256" is null and "sandboxes"."lifecycle_snapshot_size_bytes" is null) or ("sandboxes"."lifecycle_snapshot_id" is not null and "sandboxes"."lifecycle_snapshot_sha256" ~ '^[a-f0-9]{64}$' and "sandboxes"."lifecycle_snapshot_size_bytes" > 0));