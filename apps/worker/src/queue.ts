import { Queue, Worker, type Job, type QueueOptions, type WorkerOptions } from "bullmq";
import { statfs } from "node:fs/promises";
import { count } from "drizzle-orm";
import { createTelemetryLogger, evaluateOperationalAlerts, TelemetryMetrics, withTelemetryContext } from "@meta-game/config";
import type { GameDatabase } from "@meta-game/db";
import {
  claimRunOutboxBatch,
  isQueuedRunDispatchable,
  listDispatchedQueuedRuns,
  markRunOutboxDispatched,
  markRunOutboxRetryable,
  reopenMissingQueuedRunOutbox,
  sandboxes,
  type ClaimedRunOutbox,
} from "@meta-game/db";
import { RunQueueJobSchema, type RunQueueJob } from "@meta-game/contracts";
import { RunProcessingError, type RunHandler, type WorkerRun } from "./handler";
import {
  claimRun,
  finishClaimedRun,
  reconcileExpiredRunLeases,
  releaseRunForRetry,
  renewRunLease,
  transitionClaimedRun,
} from "@meta-game/db";

export const RUN_QUEUE_NAME = "meta-game-runs";
const MAX_JOB_ATTEMPTS = 3;

export function redisConnectionOptions(redisUrl: string, worker = false): NonNullable<QueueOptions["connection"]> {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL debe ser una URL Redis válida.");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") throw new Error("REDIS_URL debe usar redis o rediss.");
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isSafeInteger(database) || database < 0) throw new Error("REDIS_URL tiene un índice de base inválido.");
  const options = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db: database,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
  };
  return options as NonNullable<QueueOptions["connection"]>;
}

export function createRunQueue(redisUrl: string, queueName = RUN_QUEUE_NAME): Queue<RunQueueJob> {
  return new Queue<RunQueueJob>(queueName, {
    connection: redisConnectionOptions(redisUrl),
    defaultJobOptions: {
      attempts: MAX_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });
}

type RemovableRunJob = Readonly<{
  getState(): Promise<string>;
  remove(): Promise<void>;
}>;

type RunJobLookup = Readonly<{
  getJob(jobId: string): Promise<RemovableRunJob | undefined>;
}>;

export async function removeProjectRunJobs(
  queue: RunJobLookup,
  jobs: readonly { runId: string; generation: number }[],
): Promise<void> {
  for (const { runId, generation } of jobs) {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("project_cleanup_job_reference_invalid");
    const job = await queue.getJob(`run-${runId}-${generation}`);
    if (!job) continue;
    if (await job.getState() === "active") throw new Error("project_cleanup_job_active");
    await job.remove();
  }
}

async function dispatchOne(database: GameDatabase, queue: Queue<RunQueueJob>, item: ClaimedRunOutbox): Promise<void> {
  try {
    const payload = RunQueueJobSchema.parse({ runId: item.runId, idempotencyKey: item.idempotencyKey, generation: item.generation });
    await queue.add("run", payload, {
      jobId: `run-${payload.runId}-${payload.generation}`,
      attempts: MAX_JOB_ATTEMPTS,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
    const marked = await markRunOutboxDispatched(database, item);
    if (!marked && !await isQueuedRunDispatchable(database, payload.runId)) {
      const job = await queue.getJob(`run-${payload.runId}-${payload.generation}`);
      if (job && await job.getState() !== "active") await job.remove();
    }
  } catch (error) {
    await markRunOutboxRetryable(database, item, error instanceof Error && error.name === "ZodError" ? "invalid_outbox_payload" : "redis_unavailable");
    throw error;
  }
}

async function reconcileRedisQueue(database: GameDatabase, queue: Queue<RunQueueJob>, metrics?: TelemetryMetrics): Promise<void> {
  const expired = await reconcileExpiredRunLeases(database, 100);
  if (expired > 0) {
    metrics?.increment("run_lock_events_total", { outcome: "expired" }, expired);
    return;
  }
  const rows = await listDispatchedQueuedRuns(database, 100);
  for (const row of rows) {
    const jobId = `run-${row.runId}-${row.generation}`;
    const job = await queue.getJob(jobId);
    if (!job) {
      await reopenMissingQueuedRunOutbox(database, row);
      continue;
    }
    const state = await job.getState();
    if (state === "failed" || state === "completed") {
      await job.remove();
      await reopenMissingQueuedRunOutbox(database, row);
    }
  }
}

async function processRun(
  database: GameDatabase,
  job: Job<RunQueueJob>,
  handler: RunHandler,
  leaseMs: number,
  metrics?: TelemetryMetrics,
): Promise<{ status: "processed" | "skipped"; outcome: "succeeded" | "failed" | "cancelled" | "skipped" }> {
  const payload = RunQueueJobSchema.parse(job.data);
  let claimed: Awaited<ReturnType<typeof claimRun>>;
  try { claimed = await claimRun(database, { ...payload, leaseMs }); }
  catch (error) {
    metrics?.increment("run_lock_events_total", { outcome: "error" });
    throw error;
  }
  if (!claimed) {
    metrics?.increment("run_lock_events_total", { outcome: "busy" });
    return { status: "skipped", outcome: "skipped" };
  }
  metrics?.increment("run_lock_events_total", { outcome: "acquired" });
  const { claim, cancelRequested } = claimed;
  const controller = new AbortController();
  const finish = async (input: Parameters<typeof finishClaimedRun>[2]) => {
    await finishClaimedRun(database, claim, input);
    metrics?.increment("run_lock_events_total", { outcome: "released" });
  };
  let verifying = false;
  const markVerifying = async () => {
    if (verifying) return;
    await transitionClaimedRun(database, claim, "verifying");
    verifying = true;
  };
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void renewRunLease(database, claim, leaseMs)
      .then((result) => {
        metrics?.increment("run_lock_events_total", { outcome: result.valid ? "renewed" : "lost" });
        if (!result.valid || result.cancelRequested) {
          controller.abort();
          clearInterval(heartbeat);
        }
      })
      .catch(() => {
        metrics?.increment("run_lock_events_total", { outcome: "error" });
        controller.abort();
        clearInterval(heartbeat);
      })
      .finally(() => { heartbeatBusy = false; });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  heartbeat.unref();

  try {
    if (cancelRequested) {
      await finish({ status: "cancelled" });
      return { status: "processed", outcome: "cancelled" };
    }
    await transitionClaimedRun(database, claim, "running");
    const run: WorkerRun = { id: payload.runId, projectId: claim.projectId, idempotencyKey: payload.idempotencyKey };
    const result = await handler(run, { signal: controller.signal, claim, markVerifying });
    if (controller.signal.aborted) {
      await finish({ status: "cancelled", usage: result.usage });
      return { status: "processed", outcome: "cancelled" };
    }
    await markVerifying();
    await finish({ status: "succeeded", usage: result.usage });
    return { status: "processed", outcome: "succeeded" };
  } catch (error) {
    if (controller.signal.aborted) {
      await finish({
        status: "cancelled",
        usage: error instanceof RunProcessingError ? error.usage : undefined,
      });
      return { status: "processed", outcome: "cancelled" };
    }
    if (error instanceof RunProcessingError && !error.retryable) {
      await finish({ status: "failed", errorCode: error.code, usage: error.usage });
      return { status: "processed", outcome: "failed" };
    }
    const attempts = job.opts.attempts ?? MAX_JOB_ATTEMPTS;
    if (job.attemptsMade + 1 >= attempts) {
      await finish({ status: "failed", errorCode: "worker_retries_exhausted" });
      return { status: "processed", outcome: "failed" };
    }
    await releaseRunForRetry(database, claim, job.attemptsMade + 1);
    metrics?.increment("run_lock_events_total", { outcome: "retry" });
    throw error instanceof Error ? error : new Error("worker_retryable_error");
  } finally {
    clearInterval(heartbeat);
  }
}

export interface RunWorkerServiceOptions {
  database: GameDatabase;
  redisUrl: string;
  queueName?: string;
  handler: RunHandler;
  leaseMs?: number;
  pollIntervalMs?: number;
  concurrency?: number;
  metrics?: TelemetryMetrics;
}

export function startRunWorkerService(options: RunWorkerServiceOptions) {
  const queueName = options.queueName ?? RUN_QUEUE_NAME;
  const leaseMs = options.leaseMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const queue = createRunQueue(options.redisUrl, queueName);
  const logger = createTelemetryLogger("worker");
  const metrics = options.metrics;
  const alertWindow: Array<{ at: number; providerRequests: number; providerErrors: number; cleanupFailures: number }> = [];
  const previousCounters = new Map<string, number>();
  const activeAlerts = new Set<string>();
  const counterDelta = (key: string, current: number): number => {
    const previous = previousCounters.get(key) ?? current;
    previousCounters.set(key, current);
    return current >= previous ? current - previous : current;
  };
  const updateMetrics = async () => {
    if (!metrics) return;
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
    for (const state of ["waiting", "active", "delayed", "failed"] as const) metrics.set("queue_jobs", counts[state] ?? 0, { state });
    const sandboxCounts = await options.database.select({ state: sandboxes.status, instances: count() }).from(sandboxes).groupBy(sandboxes.status);
    const sandboxStates = ["provisioning", "ready", "suspending", "suspended", "stopping", "stopped", "failed"] as const;
    for (const state of sandboxStates) {
      const instances = sandboxCounts.find((item) => item.state === state)?.instances ?? 0;
      metrics.set("sandbox_instances", instances, { state });
    }
    const waiting = await queue.getJobs(["waiting"], 0, 99, false);
    const oldestMs = waiting.reduce((value, job) => Math.max(value, Math.max(0, Date.now() - job.timestamp)), 0);
    const oldestSeconds = oldestMs / 1_000;
    metrics.set("queue_oldest_waiting_seconds", oldestSeconds);
    metrics.set("queue_stuck_jobs", oldestSeconds >= 900 ? counts.waiting ?? 0 : 0);
    let diskUsedRatio: number | undefined;
    if (process.platform === "linux") {
      const filesystem = await statfs("/");
      const total = Number(filesystem.blocks) * Number(filesystem.bsize);
      const free = Number(filesystem.bavail) * Number(filesystem.bsize);
      if (total > 0 && Number.isFinite(total) && Number.isFinite(free)) {
        diskUsedRatio = Math.min(1, Math.max(0, 1 - free / total));
        metrics.set("disk_used_ratio", diskUsedRatio, { mount: "root" });
      }
    }
    const tasks = ["plan", "code", "image", "smoke"] as const;
    let providerRequests = 0;
    let providerErrors = 0;
    for (const task of tasks) {
      const succeeded = metrics.value("meta_requests_total", { task, outcome: "success" });
      const failed = metrics.value("meta_requests_total", { task, outcome: "error" });
      const ambiguous = metrics.value("meta_requests_total", { task, outcome: "ambiguous" });
      providerRequests += counterDelta("meta:" + task + ":success", succeeded) + counterDelta("meta:" + task + ":error", failed) + counterDelta("meta:" + task + ":ambiguous", ambiguous);
      providerErrors += counterDelta("error:" + task, failed) + counterDelta("ambiguous:" + task, ambiguous);
    }
    const cleanupFailures = counterDelta("cleanup:failed", metrics.value("cleanup_runs_total", { outcome: "failed" }));
    const now = Date.now();
    alertWindow.push({ at: now, providerRequests, providerErrors, cleanupFailures });
    while (alertWindow.length && alertWindow[0]!.at < now - 300_000) alertWindow.shift();
    const signals = alertWindow.reduce((result, item) => ({
      providerRequests: result.providerRequests + item.providerRequests,
      providerErrors: result.providerErrors + item.providerErrors,
      cleanupFailures: result.cleanupFailures + item.cleanupFailures,
    }), { providerRequests: 0, providerErrors: 0, cleanupFailures: 0 });
    const currentAlerts = new Set(evaluateOperationalAlerts({
      oldestWaitingSeconds: oldestSeconds,
      diskUsedRatio,
      ...signals,
    }));
    for (const alert of currentAlerts) if (!activeAlerts.has(alert)) logger.error("alert.fired", { alert });
    for (const alert of activeAlerts) if (!currentAlerts.has(alert)) logger.info("alert.resolved", { alert });
    activeAlerts.clear();
    for (const alert of currentAlerts) activeAlerts.add(alert);
  };
  const worker = new Worker<RunQueueJob>(
    queueName,
    async (job) => {
      const started = Date.now();
      return withTelemetryContext({ runId: job.data.runId }, async () => {
        logger.info("run.started");
        let outcome: "succeeded" | "failed" | "cancelled" | "skipped" = "failed";
        try {
          const result = await processRun(options.database, job, options.handler, leaseMs, metrics);
          outcome = result.outcome;
          return result;
        } catch {
          logger.error("run.retryable_error", { errorCode: "worker_retryable_error" });
          throw new Error("worker_retryable_error");
        } finally {
          const durationMs = Math.max(0, Date.now() - started);
          metrics?.increment("run_jobs_total", { outcome });
          metrics?.observe("run_duration_seconds", durationMs / 1_000, { outcome });
          logger.info("run.finished", { outcome, durationMs });
        }
      });
    },
    {
      connection: redisConnectionOptions(options.redisUrl, true),
      concurrency: options.concurrency ?? 4,
      lockDuration: leaseMs,
      stalledInterval: leaseMs,
      maxStalledCount: 1,
    } satisfies WorkerOptions,
  );

  let polling = false;
  let closed = false;
  const poll = async () => {
    if (polling || closed) return;
    polling = true;
    try {
      await reconcileRedisQueue(options.database, queue, metrics);
      try { await updateMetrics(); } catch { logger.warn("metrics.collection_failed", { errorCode: "metrics_collection_failed" }); }
      const batch = await claimRunOutboxBatch(options.database, { limit: 25, leaseMs: Math.min(120_000, Math.max(3_000, leaseMs)) });
      for (const item of batch) await dispatchOne(options.database, queue, item);
    } catch {
      logger.error("queue.reconciliation_failed", { errorCode: "queue_reconciliation_failed" });
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => { void poll(); }, pollIntervalMs);
  timer.unref();
  void poll();

  worker.on("error", () => logger.error("run_worker.failed", { errorCode: "worker_runtime_failed" }));

  return {
    queue,
    worker,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await worker.close();
      await queue.close();
    },
  };
}
