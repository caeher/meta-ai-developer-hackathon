ALTER TABLE "sandboxes" ADD COLUMN "dev_server_status" varchar(16) DEFAULT 'stopped' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "dev_server_port" integer;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "dev_server_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_dev_server_status_check" CHECK ("sandboxes"."dev_server_status" in ('stopped', 'starting', 'ready', 'failed'));--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_dev_server_port_check" CHECK ("sandboxes"."dev_server_port" is null or "sandboxes"."dev_server_port" between 1024 and 65535);--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_dev_server_ready_check" CHECK (("sandboxes"."dev_server_status" in ('starting', 'ready')) = ("sandboxes"."dev_server_port" is not null and "sandboxes"."dev_server_lease_expires_at" is not null));
