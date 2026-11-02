DROP TABLE "auth_rate_limits";--> statement-breakpoint
DROP TABLE "auth_tokens";--> statement-breakpoint
DROP TABLE "auth_sessions";--> statement-breakpoint
DROP TYPE "auth_token_purpose";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_email_lowercase_check";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_user_id_unique";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email_verified_at";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "clerk_user_id" varchar(255);--> statement-breakpoint
UPDATE "users" SET "clerk_user_id" = "user_id" WHERE "clerk_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "clerk_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "user_id";
