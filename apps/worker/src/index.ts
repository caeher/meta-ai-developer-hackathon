import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDatabaseFromEnvironment, createRepositories } from "@meta-game/db";
import { parseRunEnvironment } from "@meta-game/config";
import { loadMetaConfig, MetaClient } from "@meta-game/meta";
import { SandboxControllerClient } from "@meta-game/sandbox";
import { createPrivateCheckpointStorageFromEnvironment, createPrivateSnapshotStorageFromEnvironment, createPrivateStorageFromEnvironment, createPublicationArtifactStorageFromEnvironment } from "@meta-game/storage";
import { createSkillRouter } from "@meta-game/skills";
import { createAgentRunHandler } from "./agent/orchestrator";
import { createPostgresAgentRunStore } from "./agent/store";
import { createGeneratedImageTool } from "./assets/image-generator";
import { pendingOrchestratorHandler } from "./handler";
import { startRunWorkerService } from "./queue";
import { createVersionService } from "./versions/service";
import { createWorkerVersionServer } from "./versions/http";
import { createPublicationPipeline } from "./pipelines/publish-game";

// Load only the repository .env for local runs. dotenv does not read .env.local here.
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const environment = parseRunEnvironment(process.env);
const database = createDatabaseFromEnvironment();
let versionService: ReturnType<typeof createVersionService> | undefined;
let publicationPipeline: ReturnType<typeof createPublicationPipeline> | undefined;
let sandboxClient: SandboxControllerClient | undefined;
let snapshotStorage: ReturnType<typeof createPrivateSnapshotStorageFromEnvironment> | undefined;
const repositories = createRepositories(database.db);
const closeCallbacks: Array<() => void> = [];
if (environment.PUBLISHING_ENABLED) initializePublicationPipeline();
const handler = environment.RUNS_ENABLED
  ? await createEnabledAgentHandler()
  : pendingOrchestratorHandler;
const service = startRunWorkerService({
  database: database.db,
  redisUrl: environment.REDIS_URL,
  handler,
});

let snapshotReconciler: NodeJS.Timeout | undefined;
if (versionService && environment.RUNS_ENABLED) {
  const reconcile = async () => {
    try {
      const result = await versionService!.reconcilePendingSnapshots();
      if (result.recovered || result.failed) {
        process.stdout.write(`snapshot_reconciliation scanned=${result.scanned} recovered=${result.recovered} failed=${result.failed} deferred=${result.deferred}\n`);
      }
    } catch {
      process.stderr.write("snapshot_reconciliation_failed\n");
    }
  };
  void reconcile();
  snapshotReconciler = setInterval(() => { void reconcile(); }, 60_000);
  snapshotReconciler.unref();
}

let publicationReconciler: NodeJS.Timeout | undefined;
if (publicationPipeline) {
  const reconcile = async () => {
    try {
      const result = await publicationPipeline!.reconcileExpiredBuilds();
      if (result.started || result.cleaned) process.stdout.write(`publication_reconciliation scanned=${result.scanned} started=${result.started} cleaned=${result.cleaned}\n`);
    } catch { process.stderr.write("publication_reconciliation_failed\n"); }
  };
  void reconcile();
  publicationReconciler = setInterval(() => { void reconcile(); }, 30_000);
  publicationReconciler.unref();
}

let versionServer: ReturnType<typeof createWorkerVersionServer> | undefined;
if (environment.RUNS_ENABLED || environment.PUBLISHING_ENABLED) {
  const token = process.env.WORKER_INTERNAL_TOKEN;
  const port = Number(process.env.WORKER_INTERNAL_PORT ?? "8082");
  if ((!versionService && environment.RUNS_ENABLED) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("RUNS_ENABLED or PUBLISHING_ENABLED requires the internal service");
  }
  versionServer = createWorkerVersionServer({
    token: token ?? "",
    ...(environment.RUNS_ENABLED && versionService ? { restore: (identity, projectId, versionId) => versionService!.restore(identity, projectId, versionId) } : {}),
    ...(publicationPipeline ? {
      publish: (identity, projectId, versionId, idempotencyKey) => publicationPipeline!.start(identity, projectId, versionId, idempotencyKey),
      revoke: (identity, projectId, publicationId) => publicationPipeline!.revoke(identity, projectId, publicationId),
    } : {}),
  });
  versionServer.listen(port, "0.0.0.0");
}

async function createEnabledAgentHandler() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const store = createPostgresAgentRunStore(database.db);
  const skills = await createSkillRouter({ rootDir });
  const sandbox = getSandboxClient();
  const meta = new MetaClient(loadMetaConfig());
  const storage = createPrivateStorageFromEnvironment(repositories.assets);
  const checkpoints = createPrivateCheckpointStorageFromEnvironment();
  closeCallbacks.push(() => { storage.close(); }, () => { checkpoints.close(); });
  const versions = getVersionService(sandbox);
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
    versions,
    skills,
    maxSteps: environment.PROJECT_MAX_RUN_STEPS,
    maxTokens: environment.RUN_MAX_TOKENS,
    maxDurationMs: environment.RUN_MAX_DURATION_MS,
    dailyImageLimit: environment.USER_DAILY_IMAGE_LIMIT,
    imageGenerator,
  });
}

function getSandboxClient(): SandboxControllerClient {
  if (sandboxClient) return sandboxClient;
  if (process.env.SANDBOX_DRIVER !== "rootless") throw new Error("RUNS_ENABLED or PUBLISHING_ENABLED requires SANDBOX_DRIVER=rootless on the dedicated Linux host");
  const controllerUrl = process.env.SANDBOX_CONTROLLER_URL;
  const controllerToken = process.env.SANDBOX_CONTROLLER_TOKEN;
  if (!controllerUrl || !controllerToken) throw new Error("RUNS_ENABLED or PUBLISHING_ENABLED requires the private sandbox controller");
  sandboxClient = new SandboxControllerClient(controllerUrl, controllerToken);
  return sandboxClient;
}

function getVersionService(sandbox = getSandboxClient()) {
  if (versionService) return versionService;
  snapshotStorage = createPrivateSnapshotStorageFromEnvironment();
  closeCallbacks.push(() => snapshotStorage?.close());
  versionService = createVersionService({ versions: repositories.versions, storage: snapshotStorage, sandbox });
  return versionService;
}

function initializePublicationPipeline() {
  const sandbox = getSandboxClient();
  const versions = getVersionService(sandbox);
  const artifacts = createPublicationArtifactStorageFromEnvironment(process.env, "worker");
  closeCallbacks.push(() => artifacts.close());
  publicationPipeline = createPublicationPipeline({ repositories, versions, sandbox, artifacts });
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (snapshotReconciler) clearInterval(snapshotReconciler);
  if (publicationReconciler) clearInterval(publicationReconciler);
  if (versionServer) await new Promise<void>((resolve, reject) => versionServer!.close((error) => error ? reject(error) : resolve()));
  await publicationPipeline?.close();
  await service.close();
  for (const close of closeCallbacks.reverse()) close();
  await database.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
