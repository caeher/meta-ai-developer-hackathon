import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { createDatabaseFromEnvironment, createRepositories } from "@meta-game/db";
import { parseRunEnvironment } from "@meta-game/config";
import { SandboxControllerClient } from "@meta-game/sandbox";
import { createRedisPreviewStore } from "@meta-game/preview";
import {
  createPrivateCheckpointStorageFromEnvironment,
  createPrivateSnapshotStorageFromEnvironment,
  createPublicationArtifactStorageFromEnvironment,
  createS3PrivateObjectClient,
  readStorageEnvironment,
} from "@meta-game/storage";
import { createVersionService } from "../apps/worker/src/versions/service";
import { createResourceLifecycleService } from "../apps/worker/src/lifecycle/service";
import { createRunQueue, removeProjectRunJobs } from "../apps/worker/src/queue";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const environment = parseRunEnvironment(process.env);
if (!environment.RESOURCE_LIFECYCLE_ENABLED || process.env.SANDBOX_DRIVER !== "rootless") {
  throw new Error("Resource reconciliation requires RESOURCE_LIFECYCLE_ENABLED=true and SANDBOX_DRIVER=rootless");
}
const controllerUrl = process.env.SANDBOX_CONTROLLER_URL;
const controllerToken = process.env.SANDBOX_CONTROLLER_TOKEN;
if (!controllerUrl || !controllerToken) throw new Error("Resource reconciliation requires the private sandbox controller");

const database = createDatabaseFromEnvironment();
const repositories = createRepositories(database.db, {
  maxProjects: environment.USER_MAX_PROJECTS,
  maxStorageBytes: environment.USER_MAX_STORAGE_MB * 1024 * 1024,
  maxConcurrentJobs: environment.USER_MAX_CONCURRENT_JOBS,
  runMaxTokens: environment.RUN_MAX_TOKENS,
  dailyTokenLimit: environment.USER_DAILY_TOKEN_LIMIT,
  dailyImageLimit: environment.USER_DAILY_IMAGE_LIMIT,
  runMaxDurationMs: environment.RUN_MAX_DURATION_MS,
});
const sandbox = new SandboxControllerClient(controllerUrl, controllerToken);
const runQueue = createRunQueue(environment.REDIS_URL);
const snapshots = createPrivateSnapshotStorageFromEnvironment();
const checkpoints = createPrivateCheckpointStorageFromEnvironment();
const privateObjects = createS3PrivateObjectClient(readStorageEnvironment());
const previewStore = process.env.PREVIEW_GATEWAY_ENABLED === "true" ? createRedisPreviewStore(environment.REDIS_URL) : undefined;
const publications = environment.PUBLISHING_ENABLED
  ? createPublicationArtifactStorageFromEnvironment(process.env, "worker")
  : undefined;
const versions = createVersionService({
  versions: repositories.versions,
  storage: snapshots,
  sandbox,
  maxStorageBytes: environment.USER_MAX_STORAGE_MB * 1024 * 1024,
});
const lifecycle = createResourceLifecycleService({
  database: database.db,
  sandbox,
  snapshots: versions,
  idleTtlSeconds: environment.SANDBOX_IDLE_TTL_SECONDS,
  activeConnectionGraceSeconds: process.env.PREVIEW_GATEWAY_ENABLED === "true" ? environment.PREVIEW_SESSION_TTL_SECONDS : 0,
  retentionDays: environment.PROJECT_DELETION_RETENTION_DAYS,
  maxStorageBytes: environment.USER_MAX_STORAGE_MB * 1024 * 1024,
  privateObjects,
  checkpoints,
  jobs: { removeProjectRuns: (jobs) => removeProjectRunJobs(runQueue, jobs) },
  ...(previewStore ? { hasActivePreview: (projectId: string) => previewStore.hasActiveProjectSessions(projectId) } : {}),
  ...(publications ? { publications } : {}),
});

try {
  const quiescedSandboxes = await lifecycle.reapDeletedSandboxes();
  const suspended = await lifecycle.suspendExpired();
  const deletedProjects = await lifecycle.reconcileDeletedProjects();
  process.stdout.write(JSON.stringify({ quiescedSandboxes, suspended, deletedProjects }) + "\n");
} finally {
  await runQueue.close();
  await publications?.close();
  await previewStore?.close();
  privateObjects.close?.();
  checkpoints.close();
  snapshots.close();
  await database.close();
}
