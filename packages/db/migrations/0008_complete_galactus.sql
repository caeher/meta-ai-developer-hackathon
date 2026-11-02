ALTER TABLE "versions" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "parent_version_id" uuid;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "manifest" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD CONSTRAINT "versions_owner_project_run_fk" FOREIGN KEY ("owner_user_id","project_id","run_id") REFERENCES "public"."runs"("owner_user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "versions_owner_project_run_unique" ON "versions" USING btree ("owner_user_id","project_id","run_id") WHERE "versions"."run_id" is not null;