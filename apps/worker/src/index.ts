import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDatabaseFromEnvironment, createRepositories } from "@meta-game/db";
import { parseRunEnvironment } from "@meta-game/config";
import { loadMetaConfig, MetaClient } from "@meta-game/meta";
import { SandboxControllerClient } from "@meta-game/sandbox";
import { createPrivateCheckpointStorageFromEnvironment, createPrivateSnapshotStorageFromEnvironment, createPrivateStorageFromEnvironment } from "@meta-game/storage";
import { createSkillRouter } from "@meta-game/skills";
import { createAgentRunHandler } from "./agent/orchestrator";
import { createPostgresAgentRunStore } from "./agent/store";
import { createGeneratedImageTool } from "./assets/image-generator";
import { pendingOrchestratorHandler } from "./handler";
import { startRunWorkerService } from "./queue";
import { createVersionService } from "./versions/service";
import { createWorkerVersionServer } from "./versions/http";

// Load only the repository .env for local runs. dotenv does not read .env.local here.
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const environment = parseRunEnvironment(process.env);
const database = createDatabaseFromEnvironment();
let closeGeneratedAssetStorage: (() => void) | undefined;
let versionService: ReturnType<typeof createVersionService> | undefined;
const handler = environment.RUNS_ENABLED
  ? await createEnabledAgentHandler()
  : pendingOrchestratorHandler;
const service = startRunWorkerService({
  database: database.db,
  redisUrl: environment.REDIS_URL,
  handler,
});

let versionServer: ReturnType<typeof createWorkerVersionServer> | undefined;
if (environment.RUNS_ENABLED) {
  const token = process.env.WORKER_INTERNAL_TOKEN;
  const port = Number(process.env.WORKER_INTERNAL_PORT ?? "8082");
  if (!versionService || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("RUNS_ENABLED requires the internal version restore service");
  }
  versionServer = createWorkerVersionServer({ token: token ?? "", restore: (identity, projectId, versionId) => versionService!.restore(identity, projectId, versionId) });
  versionServer.listen(port, "0.0.0.0");
}

async function createEnabledAgentHandler() {
  if (process.env.SANDBOX_DRIVER !== "rootless") {
    throw new Error("RUNS_ENABLED requires SANDBOX_DRIVER=rootless on the dedicated Linux host");
  }
  const controllerUrl = process.env.SANDBOX_CONTROLLER_URL;
  const controllerToken = process.env.SANDBOX_CONTROLLER_TOKEN;
  if (!controllerUrl || !controllerToken) {
    throw new Error("RUNS_ENABLED requires SANDBOX_CONTROLLER_URL and SANDBOX_CONTROLLER_TOKEN");
  }
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const store = createPostgresAgentRunStore(database.db);
  const skills = await createSkillRouter({ rootDir });
  const sandbox = new SandboxControllerClient(controllerUrl, controllerToken);
  const meta = new MetaClient(loadMetaConfig());
  const repositories = createRepositories(database.db);
  const storage = createPrivateStorageFromEnvironment(repositories.assets);
  const checkpoints = createPrivateCheckpointStorageFromEnvironment();
  const snapshotStorage = createPrivateSnapshotStorageFromEnvironment();
  closeGeneratedAssetStorage = () => { storage.close(); checkpoints.close(); snapshotStorage.close(); };
  versionService = createVersionService({ versions: repositories.versions, storage: snapshotStorage, sandbox });
  const imageGenerator = createGeneratedImageTool({
    meta,
    storage,
    sandbox,
    identity: store.identity,
  });
  return createAgentRunHandler({
    store,
    meta,
    sandbox,
    checkpoints,
    versions: versionService,
    skills,
    maxSteps: environment.PROJECT_MAX_RUN_STEPS,
    maxTokens: environment.RUN_MAX_TOKENS,
    maxDurationMs: environment.RUN_MAX_DURATION_MS,
    dailyImageLimit: environment.USER_DAILY_IMAGE_LIMIT,
    imageGenerator,
  });
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await service.close();
  if (versionServer) await new Promise<void>((resolve, reject) => versionServer!.close((error) => error ? reject(error) : resolve()));
  closeGeneratedAssetStorage?.();
  await database.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
