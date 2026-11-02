ALTER TABLE "sandboxes" DROP CONSTRAINT "sandboxes_runtime_uid_range_check";
ALTER TABLE "sandboxes" DROP CONSTRAINT "sandboxes_runtime_uid_unique";
ALTER TABLE "sandboxes" DROP COLUMN "runtime_uid";
DROP SEQUENCE "sandboxes_runtime_uid_seq";
