ALTER TABLE "users" ADD COLUMN "contributor_consent_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users" SET "contributor_consent_at" = now() WHERE "deleted_at" IS NULL AND "contributor_consent_at" IS NULL;
