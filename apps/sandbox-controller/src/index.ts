import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { createDatabaseFromEnvironment } from "@meta-game/db";
import { parseSandboxEnvironment } from "@meta-game/config";
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
const driver = new RootlessDockerDriver(environment.SANDBOX_DOCKER_SOCKET, environment.SANDBOX_IMAGE, limits);
await driver.verifyHost();
const service = new SandboxService(createSandboxRegistry(database.db), driver, environment);
await service.reapExpired();
const server = createSandboxControllerServer(service, environment.SANDBOX_CONTROLLER_TOKEN);

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(environment.SANDBOX_CONTROLLER_PORT, environment.SANDBOX_CONTROLLER_HOST, resolve);
});

const reaper = setInterval(() => {
  void service.reapExpired().catch((error: unknown) => {
    const code = error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message) ? error.message : "sandbox_reaper_failed";
    process.stderr.write(`${code}\n`);
  });
}, 30_000);
reaper.unref();
process.stdout.write(`sandbox_controller_listening ${environment.SANDBOX_CONTROLLER_HOST}:${environment.SANDBOX_CONTROLLER_PORT}\n`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(reaper);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await database.close();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
