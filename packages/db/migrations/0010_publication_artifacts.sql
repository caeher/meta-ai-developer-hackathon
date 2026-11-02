ALTER TABLE "projects" ADD COLUMN "is_internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "idempotency_key" varchar(128);--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "artifact_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "manifest" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "build_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "build_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "publications_owner_project_idempotency_unique" ON "publications" USING btree ("owner_user_id","project_id","idempotency_key") WHERE "publications"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "publications_build_lease_idx" ON "publications" USING btree ("status","build_lease_expires_at");--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_artifact_sha256_format_check" CHECK ("publications"."artifact_sha256" is null or "publications"."artifact_sha256" ~ '^[a-f0-9]{64}$');