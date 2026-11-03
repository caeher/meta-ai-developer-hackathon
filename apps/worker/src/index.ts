import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDatabaseFromEnvironment, createRepositories } from "@meta-game/db";
import { parseRunEnvironment } from "@meta-game/config";
import { loadMetaConfig, MetaClient } from "@meta-game/meta";
import { SandboxControllerClient } from "@meta-game/sandbox";
import { createPrivateCheckpointStorageFromEnvironment, createPrivateSnapshotStorageFromEnvironment, createPrivateStorageFromEnvironment, createPublicationArtifactStorageFromEnvironment, createS3PrivateObjectClient, readStorageEnvironment } from "@meta-game/storage";
import { createSkillRouter } from "@meta-game/skills";
import { createAgentRunHandler } from "./agent/orchestrator";
import { createPostgresAgentRunStore } from "./agent/store";
import { createGeneratedImageTool } from "./assets/image-generator";
import { createEditSpriteTool } from "./assets/edit-sprite";
import { createCreateTilesetTool } from "./assets/create-tileset";
import { createCreateTilemapTool } from "./assets/create-tilemap";
import { createPackSpritesheetTool } from "./assets/pack-spritesheet";
import { createDefineAnimationTool } from "./assets/define-animation";
import { createInspectAssetTool } from "./assets/inspect-asset";
import { pendingOrchestratorHandler } from "./handler";
import { removeProjectRunJobs, startRunWorkerService } from "./queue";
import { createVersionService } from "./versions/service";
import { createWorkerVersionServer } from "./versions/http";
import { createPublicationPipeline } from "./pipelines/publish-game";
import { createResourceLifecycleService } from "./lifecycle/service";
import { createRedisPreviewStore } from "@meta-game/preview";

// Load only the repository .env for local runs. dotenv does not read .env.local here.
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const environment = parseRunEnvironment(process.env);
const database = createDatabaseFromEnvironment();
let versionService: ReturnType<typeof createVersionService> | undefined;
let publicationPipeline: ReturnType<typeof createPublicationPipeline> | undefined;
let checkpointStorage: ReturnType<typeof createPrivateCheckpointStorageFromEnvironment> | undefined;
let sandboxClient: SandboxControllerClient | undefined;
let resourceLifecycle: ReturnType<typeof createResourceLifecycleService> | undefined;
const projectJobCleaner: { remove: ((jobs: readonly { runId: string; generation: number }[]) => Promise<void>) | undefined } = { remove: undefined };
let snapshotStorage: ReturnType<typeof createPrivateSnapshotStorageFromEnvironment> | undefined;
let previewStore: ReturnType<typeof createRedisPreviewStore> | undefined;
const repositories = createRepositories(database.db, {
  maxProjects: environment.USER_MAX_PROJECTS,
  maxStorageBytes: environment.USER_MAX_STORAGE_MB * 1024 * 1024,
  maxConcurrentJobs: environment.USER_MAX_CONCURRENT_JOBS,
  runMaxTokens: environment.RUN_MAX_TOKENS,
  dailyTokenLimit: environment.USER_DAILY_TOKEN_LIMIT,
  dailyImageLimit: environment.USER_DAILY_IMAGE_LIMIT,
  runMaxDurationMs: environment.RUN_MAX_DURATION_MS,
});
const closeCallbacks: Array<() => void> = [];
if (environment.PUBLISHING_ENABLED) initializePublicationPipeline();
const handler = environment.RUNS_ENABLED
  ? await createEnabledAgentHandler()
  : pendingOrchestratorHandler;
if (environment.RESOURCE_LIFECYCLE_ENABLED) {
  const sandbox = getSandboxClient();
  const snapshots = getVersionService(sandbox);
  checkpointStorage = getCheckpointStorage();
  const privateObjects = createS3PrivateObjectClient(readStorageEnvironment());
  closeCallbacks.push(() => privateObjects.close?.());
  if (process.env.PREVIEW_GATEWAY_ENABLED === "true") previewStore = createRedisPreviewStore(environment.REDIS_URL);
  const publicationCleanup = environment.PUBLISHING_ENABLED
    ? createPublicationArtifactStorageFromEnvironment(process.env, "worker")
    : undefined;
  if (publicationCleanup) closeCallbacks.push(() => publicationCleanup.close());
  resourceLifecycle = createResourceLifecycleService({
    database: database.db,
    sandbox,
    snapshots,
    idleTtlSeconds: environment.SANDBOX_IDLE_TTL_SECONDS,
    activeConnectionGraceSeconds: process.env.PREVIEW_GATEWAY_ENABLED === "true" ? environment.PREVIEW_SESSION_TTL_SECONDS : 0,
    retentionDays: environment.PROJECT_DELETION_RETENTION_DAYS,
    maxStorageBytes: environment.USER_MAX_STORAGE_MB * 1024 * 1024,
    privateObjects,
    checkpoints: checkpointStorage,
    jobs: { removeProjectRuns: async (jobs) => {
      if (!projectJobCleaner.remove) throw new Error("project_cleanup_job_queue_unavailable");
      await projectJobCleaner.remove(jobs);
    } },
    ...(previewStore ? { hasActivePreview: (projectId: string) => previewStore!.hasActiveProjectSessions(projectId) } : {}),
    ...(publicationCleanup ? { publications: publicationCleanup } : {}),
  });
}
const service = startRunWorkerService({
  database: database.db,
  redisUrl: environment.REDIS_URL,
  handler,
});
projectJobCleaner.remove = (jobs) => removeProjectRunJobs(service.queue, jobs);

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

let lifecycleReconciler: NodeJS.Timeout | undefined;
if (resourceLifecycle) {
  const reconcile = async () => {
    try {
      const deletedSandboxes = await resourceLifecycle!.reapDeletedSandboxes();
      const result = await resourceLifecycle!.suspendExpired();
      const cleanup = await resourceLifecycle!.reconcileDeletedProjects();
      if (deletedSandboxes.quiesced || deletedSandboxes.failed || result.suspended || result.failed || cleanup.completed || cleanup.failed) {
        process.stdout.write(`resource_lifecycle quiesced_deleted_sandboxes=${deletedSandboxes.quiesced} quiesce_failed=${deletedSandboxes.failed} suspended=${result.suspended} preserved=${result.preserved} suspend_failed=${result.failed} cleanup_completed=${cleanup.completed} cleanup_failed=${cleanup.failed}\n`);
      }
    } catch { process.stderr.write("sandbox_lifecycle_failed\n"); }
  };
  void reconcile();
  lifecycleReconciler = setInterval(() => { void reconcile(); }, 30_000);
  lifecycleReconciler.unref();
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
  const checkpoints = getCheckpointStorage();
  closeCallbacks.push(() => { storage.close(); });
  const versions = getVersionService(sandbox);
  const imageGenerator = createGeneratedImageTool({
    meta,
    storage,
    sandbox,
    identity: store.identity,
  });
  const spriteEditor = createEditSpriteTool({
    meta,
    storage,
    sandbox,
    identity: store.identity,
  });
  const tilesetCreator = createCreateTilesetTool({ storage, sandbox, identity: store.identity });
  const tilemapCreator = createCreateTilemapTool({ storage, sandbox, identity: store.identity });
  const spritesheetPacker = createPackSpritesheetTool({ storage, sandbox, identity: store.identity });
  const animationDefiner = createDefineAnimationTool({ storage, sandbox, identity: store.identity });
  const assetInspector = createInspectAssetTool({ sandbox, storage, identity: store.identity });
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
    spriteEditor,
    tilesetCreator,
    tilemapCreator,
    spritesheetPacker,
    animationDefiner,
    assetInspector,
  });
}

function getCheckpointStorage() {
  if (checkpointStorage) return checkpointStorage;
  checkpointStorage = createPrivateCheckpointStorageFromEnvironment();
  closeCallbacks.push(() => checkpointStorage?.close());
  return checkpointStorage;
}

function getSandboxClient(): SandboxControllerClient {
  if (sandboxClient) return sandboxClient;
  if (process.env.SANDBOX_DRIVER !== "rootless") throw new Error("RUNS_ENABLED or PUBLISHING_ENABLED requires SANDBOX_DRIVER=rootless on the dedicated Linux host");
  const controllerUrl = process.env.SANDBOX_CONTROLLER_URL;
  const controllerToken = process.env.SANDBOX_CONTROLLER_TOKEN;
  if (!controllerUrl || !controllerToken) throw new Error("RUNS_ENABLED or PUBLISHING_ENABLED requires the private sandbox controller");
  const target = new SandboxControllerClient(controllerUrl, controllerToken);
  sandboxClient = new Proxy(target, {
    get(client, property, receiver) {
      if (property === "create") {
        return async (projectId: string, signal?: AbortSignal) => {
          const state = await client.create(projectId, signal);
          await resourceLifecycle?.restoreSuspended(projectId);
          return state;
        };
      }
      const value: unknown = Reflect.get(client, property, receiver);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
  return sandboxClient;
}

function getVersionService(sandbox = getSandboxClient()) {
  if (versionService) return versionService;
  snapshotStorage = createPrivateSnapshotStorageFromEnvironment();
  closeCallbacks.push(() => snapshotStorage?.close());
  versionService = createVersionService({
    versions: repositories.versions, storage: snapshotStorage, sandbox,
    maxStorageBytes: environment.USER_MAX_STORAGE_MB * 1024 * 1024,
  });
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
  if (lifecycleReconciler) clearInterval(lifecycleReconciler);
  if (publicationReconciler) clearInterval(publicationReconciler);
  if (versionServer) await new Promise<void>((resolve, reject) => versionServer!.close((error) => error ? reject(error) : resolve()));
  await publicationPipeline?.close();
  await service.close();
  await previewStore?.close();
  for (const close of closeCallbacks.reverse()) close();
  await database.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
