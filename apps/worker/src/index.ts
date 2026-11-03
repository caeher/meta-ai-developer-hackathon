import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDatabaseFromEnvironment, createRepositories } from "@meta-game/db";
import { createTelemetryLogger, createTelemetryServer, parseRunEnvironment, TelemetryMetrics } from "@meta-game/config";
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
import { createAssetReconciler } from "./assets/reconcile-assets";
import { pendingOrchestratorHandler } from "./handler";
import { removeProjectRunJobs, startRunWorkerService } from "./queue";
import { createVersionService } from "./versions/service";
import { createWorkerVersionServer } from "./versions/http";
import { createPreviewPreparationService } from "./preview/prepare";
import { createPublicationPipeline } from "./pipelines/publish-game";
import { createResourceLifecycleService } from "./lifecycle/service";
import { createRedisPreviewStore } from "@meta-game/preview";

// Load only the repository .env for local runs. dotenv does not read .env.local here.
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const environment = parseRunEnvironment(process.env);
const database = createDatabaseFromEnvironment();
const telemetryMetrics = new TelemetryMetrics("worker");
const telemetryLogger = createTelemetryLogger("worker");
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
  metrics: telemetryMetrics,
});
const observabilityPort = parseObservabilityPort(process.env.OBSERVABILITY_PORT);
const observabilityServer = createTelemetryServer({
  service: "worker",
  metrics: telemetryMetrics,
  port: observabilityPort,
  ready: async () => {
    try {
      await database.pool.query("SELECT 1");
      const redis = await service.queue.waitUntilReady();
      return redis.status === "ready";
    } catch { return false; }
  },
});
observabilityServer.on("error", () => telemetryLogger.error("observability.server_failed", { errorCode: "observability_server_failed" }));
projectJobCleaner.remove = (jobs) => removeProjectRunJobs(service.queue, jobs);

let assetReconciler: NodeJS.Timeout | undefined;
if (environment.RUNS_ENABLED) {
  const assetObjects = createS3PrivateObjectClient(readStorageEnvironment());
  closeCallbacks.push(() => assetObjects.close?.());
  const assetReconciliation = createAssetReconciler({ assets: repositories.assets, objects: assetObjects });
  const reconcileAssets = async () => {
    try {
      const result = await assetReconciliation.reconcilePendingAssets();
      if (result.recovered || result.failed || result.deleted || result.cleaned) {
        telemetryLogger.info("asset.reconciliation", { count: result.scanned, outcome: result.failed ? "failed" : "success" });
      }
    } catch {
      telemetryLogger.error("asset.reconciliation_failed", { errorCode: "asset_reconciliation_failed" });
    }
  };
  void reconcileAssets();
  assetReconciler = setInterval(() => { void reconcileAssets(); }, 60_000);
  assetReconciler.unref();
}

let snapshotReconciler: NodeJS.Timeout | undefined;
if (versionService && environment.RUNS_ENABLED) {
  const reconcile = async () => {
    try {
      const result = await versionService!.reconcilePendingSnapshots();
      if (result.recovered || result.failed) {
        telemetryLogger.info("snapshot.reconciliation", { count: result.scanned, outcome: result.failed ? "failed" : "success" });
      }
    } catch {
      telemetryLogger.error("snapshot.reconciliation_failed", { errorCode: "snapshot_reconciliation_failed" });
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
      if (cleanup.completed > 0) telemetryMetrics.increment("cleanup_runs_total", { outcome: "succeeded" }, cleanup.completed);
      if (cleanup.failed > 0) telemetryMetrics.increment("cleanup_runs_total", { outcome: "failed" }, cleanup.failed);
      if (deletedSandboxes.failed || result.failed || cleanup.failed) {
        telemetryMetrics.increment("sandbox_operations_total", { operation: "cleanup", outcome: "error" });
      }
      if (deletedSandboxes.quiesced || deletedSandboxes.failed || result.suspended || result.failed || cleanup.completed || cleanup.failed) {
        telemetryLogger.info("resource_lifecycle.reconciled", {
          count: deletedSandboxes.quiesced + result.suspended + cleanup.completed,
          outcome: cleanup.failed || result.failed || deletedSandboxes.failed ? "failed" : "success",
        });
      }
    } catch {
      telemetryMetrics.increment("cleanup_runs_total", { outcome: "failed" });
      telemetryLogger.error("sandbox_lifecycle.failed", { errorCode: "sandbox_lifecycle_failed" });
    }
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
      if (result.started || result.cleaned) telemetryLogger.info("publication.reconciliation", { count: result.scanned, outcome: "success" });
    } catch { telemetryLogger.error("publication.reconciliation_failed", { errorCode: "publication_reconciliation_failed" }); }
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
  const previewPreparation = environment.RUNS_ENABLED
    ? createPreviewPreparationService({
        projects: repositories.projects,
        sandbox: getSandboxClient(),
        isProjectBusy: async (identity, projectId) => {
          const latest = await repositories.runs.latest(identity, projectId).catch(() => undefined);
          return Boolean(latest && ["queued", "planning", "running", "verifying"].includes(latest.status));
        },
      })
    : undefined;
  versionServer = createWorkerVersionServer({
    token: token ?? "",
    ...(previewPreparation ? { preparePreview: (identity, projectId) => previewPreparation.prepare(identity, projectId) } : {}),
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
  const meta = new MetaClient(loadMetaConfig(), fetch, telemetryMetrics, readMetaBillingRates());
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
  if (process.env.SANDBOX_DRIVER !== "rootless") throw new Error("RUNS_ENABLED or PUBLISHING_ENABLED requires SANDBOX_DRIVER=rootless in the local Compose runtime");
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
  if (assetReconciler) clearInterval(assetReconciler);
  if (snapshotReconciler) clearInterval(snapshotReconciler);
  if (lifecycleReconciler) clearInterval(lifecycleReconciler);
  if (publicationReconciler) clearInterval(publicationReconciler);
  if (versionServer) await new Promise<void>((resolve, reject) => versionServer!.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => observabilityServer.close((error) => error ? reject(error) : resolve()));
  await publicationPipeline?.close();
  await service.close();
  await previewStore?.close();
  for (const close of closeCallbacks.reverse()) close();
  await database.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

function parseObservabilityPort(value: string | undefined): number {
  const port = value === undefined ? 9090 : Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) throw new Error("OBSERVABILITY_PORT must be a valid internal TCP port");
  return port;
}

function readMetaBillingRates() {
  const parse = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(raw) || !Number.isFinite(value) || value < 0 || value > 100_000) {
      throw new Error("Invalid optional Meta billing rate: " + name);
    }
    return value;
  };
  return {
    planInputUsdPerMillion: parse("META_PRICE_PLAN_INPUT_USD_PER_1M"),
    planOutputUsdPerMillion: parse("META_PRICE_PLAN_OUTPUT_USD_PER_1M"),
    codeInputUsdPerMillion: parse("META_PRICE_CODE_INPUT_USD_PER_1M"),
    codeOutputUsdPerMillion: parse("META_PRICE_CODE_OUTPUT_USD_PER_1M"),
    imageUsd: parse("META_PRICE_IMAGE_USD"),
  };
}
