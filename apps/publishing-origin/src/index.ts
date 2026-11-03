import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@meta-game/db";
import { createRepositories } from "@meta-game/db";
import { createPublicationArtifactStorageFromEnvironment } from "@meta-game/storage";
import { createPublishingOriginServer } from "./server";
import { createTelemetryLogger, createTelemetryServer, TelemetryMetrics } from "@meta-game/config";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
if (process.env.PUBLISHING_ENABLED !== "true") throw new Error("PUBLISHING_ENABLED=true is required for the public artifact origin");
const baseDomain = process.env.PUBLISH_BASE_DOMAIN ?? "";
const connectionString = process.env.PUBLISH_READ_DATABASE_URL ?? "";
const port = Number(process.env.PUBLISHING_ORIGIN_PORT ?? "8083");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PUBLISHING_ORIGIN_PORT inválido");
const database = createDatabase(connectionString, { max: 4 });
const repositories = createRepositories(database.db);
const artifacts = createPublicationArtifactStorageFromEnvironment(process.env, "reader");
const telemetryMetrics = new TelemetryMetrics("publishing-origin");
const telemetryLogger = createTelemetryLogger("publishing-origin");
const server = createPublishingOriginServer({ baseDomain, publications: repositories.publications, artifacts, metrics: telemetryMetrics });

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "0.0.0.0", resolve);
});
const observabilityPort = Number(process.env.OBSERVABILITY_PORT ?? "9090");
if (!Number.isInteger(observabilityPort) || observabilityPort < 1_024 || observabilityPort > 65_535) throw new Error("observability_port_invalid");
const observabilityServer = createTelemetryServer({
  service: "publishing-origin",
  metrics: telemetryMetrics,
  port: observabilityPort,
  ready: async () => {
    try { await database.pool.query("SELECT 1"); return true; }
    catch { return false; }
  },
});
observabilityServer.on("error", () => telemetryLogger.error("observability.server_failed", { errorCode: "observability_server_failed" }));
telemetryLogger.info("service.started", { operation: "start_server" });

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve, reject) => observabilityServer.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  artifacts.close();
  await database.close();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
