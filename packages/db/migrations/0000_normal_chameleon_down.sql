-- Rollback inicial manual. Destructivo: elimina el modelo completo y sus datos.
-- Usar solo en una base local descartable después de detener la aplicación.
DROP TABLE IF EXISTS "usage_ledger";
DROP TABLE IF EXISTS "usage_reservations";
DROP TABLE IF EXISTS "publications";
DROP TABLE IF EXISTS "versions";
DROP TABLE IF EXISTS "assets";
DROP TABLE IF EXISTS "sandboxes";
DROP TABLE IF EXISTS "run_events";
DROP TABLE IF EXISTS "messages";
DROP TABLE IF EXISTS "runs";
DROP TABLE IF EXISTS "projects";
DROP TABLE IF EXISTS "users";

DROP TYPE IF EXISTS "usage_kind";
DROP TYPE IF EXISTS "reservation_status";
DROP TYPE IF EXISTS "publication_status";
DROP TYPE IF EXISTS "version_status";
DROP TYPE IF EXISTS "asset_status";
DROP TYPE IF EXISTS "sandbox_status";
DROP TYPE IF EXISTS "run_status";
DROP TYPE IF EXISTS "message_role";
