ALTER TABLE "sandboxes"
  DROP CONSTRAINT "sandboxes_dev_server_ready_check",
  DROP CONSTRAINT "sandboxes_dev_server_port_check",
  DROP CONSTRAINT "sandboxes_dev_server_status_check",
  DROP COLUMN "dev_server_lease_expires_at",
  DROP COLUMN "dev_server_port",
  DROP COLUMN "dev_server_status";
