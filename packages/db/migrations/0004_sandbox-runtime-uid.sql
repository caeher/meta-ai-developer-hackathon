CREATE SEQUENCE "sandboxes_runtime_uid_seq" AS integer START WITH 10000 INCREMENT BY 1 MINVALUE 10000 MAXVALUE 59999 NO CYCLE CACHE 1;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "runtime_uid" integer DEFAULT nextval('sandboxes_runtime_uid_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_runtime_uid_unique" UNIQUE("runtime_uid");--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_runtime_uid_range_check" CHECK ("sandboxes"."runtime_uid" between 10000 and 59999);
