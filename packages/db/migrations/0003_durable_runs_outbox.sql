CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'dispatching', 'dispatched');--> statement-breakpoint
CREATE TABLE "project_run_locks" (
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_run_locks_owner_project_unique" UNIQUE("owner_user_id","project_id"),
	CONSTRAINT "project_run_locks_fencing_nonnegative_check" CHECK ("project_run_locks"."fencing_token" >= 0)
);
--> statement-breakpoint
CREATE TABLE "run_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_outbox_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "run_outbox_generation_nonnegative_check" CHECK ("run_outbox"."generation" >= 0),
	CONSTRAINT "run_outbox_attempts_nonnegative_check" CHECK ("run_outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "project_run_locks" ADD CONSTRAINT "project_run_locks_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_run_locks" ADD CONSTRAINT "project_run_locks_owner_project_run_fk" FOREIGN KEY ("owner_user_id","project_id","run_id") REFERENCES "public"."runs"("owner_user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_outbox" ADD CONSTRAINT "run_outbox_owner_project_run_fk" FOREIGN KEY ("owner_user_id","project_id","run_id") REFERENCES "public"."runs"("owner_user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_run_locks_lease_idx" ON "project_run_locks" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "run_outbox_status_created_idx" ON "run_outbox" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_owner_project_run_fk" FOREIGN KEY ("owner_user_id","project_id","run_id") REFERENCES "public"."runs"("owner_user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_run_id_unique" UNIQUE("run_id");