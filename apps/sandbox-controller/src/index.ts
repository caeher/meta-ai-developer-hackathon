import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { createDatabaseFromEnvironment } from "@meta-game/db";
import { createTelemetryLogger, createTelemetryServer, parseSandboxEnvironment, TelemetryMetrics } from "@meta-game/config";
import { createSandboxControllerServer, createSandboxRegistry, RootlessDockerDriver, SandboxService } from "@meta-game/sandbox";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const environment = parseSandboxEnvironment(process.env);
if (environment.SANDBOX_DRIVER !== "rootless") throw new Error("SANDBOX_DRIVER=rootless is required; execution stays disabled");

const database = createDatabaseFromEnvironment();
const limits = {
  cpu: environment.SANDBOX_CPU_LIMIT,
  memoryMb: environment.SANDBOX_MEMORY_MB,
  diskMb: environment.SANDBOX_DISK_MB,
  pids: environment.SANDBOX_PIDS_LIMIT,
  commandTimeoutMs: environment.SANDBOX_COMMAND_TIMEOUT_MS,
};
const driver = new RootlessDockerDriver(environment.SANDBOX_DOCKER_SOCKET, environment.SANDBOX_IMAGE, limits, environment.SANDBOX_EGRESS_ALLOWLIST);
await driver.verifyHost();
const service = new SandboxService(createSandboxRegistry(database.db), driver, environment);
await service.reapExpired();
const telemetryMetrics = new TelemetryMetrics("sandbox-controller");
const telemetryLogger = createTelemetryLogger("sandbox-controller");
const observabilityPort = Number(process.env.OBSERVABILITY_PORT ?? "9090");
if (!Number.isInteger(observabilityPort) || observabilityPort < 1_024 || observabilityPort > 65_535) throw new Error("observability_port_invalid");
const observabilityServer = createTelemetryServer({
  service: "sandbox-controller",
  metrics: telemetryMetrics,
  port: observabilityPort,
  ready: async () => {
    try { await database.pool.query("SELECT 1"); return true; }
    catch { return false; }
  },
});
const managedServer = createSandboxControllerServer(service, environment.SANDBOX_CONTROLLER_TOKEN, telemetryMetrics);

await new Promise<void>((resolve, reject) => {
  managedServer.once("error", reject);
  managedServer.listen(environment.SANDBOX_CONTROLLER_PORT, environment.SANDBOX_CONTROLLER_HOST, resolve);
});

const reaper = setInterval(() => {
  void service.reapExpired().then((removed) => {
    if (removed > 0) telemetryMetrics.increment("sandbox_operations_total", { operation: "cleanup", outcome: "success" }, removed);
  }).catch(() => {
    telemetryMetrics.increment("sandbox_operations_total", { operation: "cleanup", outcome: "error" });
    telemetryLogger.error("sandbox.reaper_failed", { errorCode: "sandbox_reaper_failed" });
  });
}, 30_000);
reaper.unref();
telemetryLogger.info("service.started", { operation: "start_server" });

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(reaper);
  await new Promise<void>((resolve, reject) => observabilityServer.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => managedServer.close((error) => error ? reject(error) : resolve()));
  await database.close();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
