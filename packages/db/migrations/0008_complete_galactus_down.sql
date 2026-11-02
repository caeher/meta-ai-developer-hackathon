DROP INDEX "versions_owner_project_run_unique";--> statement-breakpoint
ALTER TABLE "versions" DROP CONSTRAINT "versions_owner_project_run_fk";--> statement-breakpoint
ALTER TABLE "versions" DROP COLUMN "manifest";--> statement-breakpoint
ALTER TABLE "versions" DROP COLUMN "parent_version_id";--> statement-breakpoint
ALTER TABLE "versions" DROP COLUMN "run_id";
