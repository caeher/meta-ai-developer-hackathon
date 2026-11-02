ALTER TABLE "publications" DROP CONSTRAINT IF EXISTS "publications_artifact_sha256_format_check";
DROP INDEX IF EXISTS "publications_build_lease_idx";
DROP INDEX IF EXISTS "publications_owner_project_idempotency_unique";
ALTER TABLE "publications" DROP COLUMN IF EXISTS "build_lease_expires_at";
ALTER TABLE "publications" DROP COLUMN IF EXISTS "build_lease_token";
ALTER TABLE "publications" DROP COLUMN IF EXISTS "manifest";
ALTER TABLE "publications" DROP COLUMN IF EXISTS "artifact_sha256";
ALTER TABLE "publications" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "projects" DROP COLUMN IF EXISTS "is_internal";
