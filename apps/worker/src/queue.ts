import { Queue, Worker, type Job, type QueueOptions, type WorkerOptions } from "bullmq";
import type { GameDatabase } from "@meta-game/db";
import {
  claimRunOutboxBatch,
  listDispatchedQueuedRuns,
  markRunOutboxDispatched,
  markRunOutboxRetryable,
  reopenMissingQueuedRunOutbox,
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
    await markRunOutboxDispatched(database, item);
  } catch (error) {
    await markRunOutboxRetryable(database, item, error instanceof Error && error.name === "ZodError" ? "invalid_outbox_payload" : "redis_unavailable");
    throw error;
  }
}

async function reconcileRedisQueue(database: GameDatabase, queue: Queue<RunQueueJob>): Promise<void> {
  const expired = await reconcileExpiredRunLeases(database, 100);
  if (expired > 0) return;
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
): Promise<{ status: "processed" | "skipped" }> {
  const payload = RunQueueJobSchema.parse(job.data);
  const claimed = await claimRun(database, { ...payload, leaseMs });
  if (!claimed) return { status: "skipped" };
  const { claim, cancelRequested } = claimed;
  const controller = new AbortController();
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void renewRunLease(database, claim, leaseMs)
      .then((result) => {
        if (!result.valid || result.cancelRequested) {
          controller.abort();
          clearInterval(heartbeat);
        }
      })
      .catch(() => {
        controller.abort();
        clearInterval(heartbeat);
      })
      .finally(() => { heartbeatBusy = false; });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  heartbeat.unref();

  try {
    if (cancelRequested) {
      await finishClaimedRun(database, claim, { status: "cancelled" });
      return { status: "processed" };
    }
    await transitionClaimedRun(database, claim, "running");
    const run: WorkerRun = { id: payload.runId, projectId: claim.projectId, idempotencyKey: payload.idempotencyKey };
    const result = await handler(run, { signal: controller.signal });
    if (controller.signal.aborted) {
      await finishClaimedRun(database, claim, { status: "cancelled", usage: result.usage });
      return { status: "processed" };
    }
    await transitionClaimedRun(database, claim, "verifying");
    await finishClaimedRun(database, claim, { status: "succeeded", usage: result.usage });
    return { status: "processed" };
  } catch (error) {
    if (controller.signal.aborted) {
      await finishClaimedRun(database, claim, { status: "cancelled" });
      return { status: "processed" };
    }
    if (error instanceof RunProcessingError && !error.retryable) {
      await finishClaimedRun(database, claim, { status: "failed", errorCode: error.code });
      return { status: "processed" };
    }
    const attempts = job.opts.attempts ?? MAX_JOB_ATTEMPTS;
    if (job.attemptsMade + 1 >= attempts) {
      await finishClaimedRun(database, claim, { status: "failed", errorCode: "worker_retries_exhausted" });
      return { status: "processed" };
    }
    await releaseRunForRetry(database, claim, job.attemptsMade + 1);
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
}

export function startRunWorkerService(options: RunWorkerServiceOptions) {
  const queueName = options.queueName ?? RUN_QUEUE_NAME;
  const leaseMs = options.leaseMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const queue = createRunQueue(options.redisUrl, queueName);
  const worker = new Worker<RunQueueJob>(
    queueName,
    (job) => processRun(options.database, job, options.handler, leaseMs),
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
      await reconcileRedisQueue(options.database, queue);
      const batch = await claimRunOutboxBatch(options.database, { limit: 25, leaseMs: Math.min(120_000, Math.max(3_000, leaseMs)) });
      for (const item of batch) await dispatchOne(options.database, queue, item);
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      process.stderr.write(`run_queue_reconciliation_error ${name}\n`);
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => { void poll(); }, pollIntervalMs);
  timer.unref();
  void poll();

  worker.on("error", (error) => process.stderr.write(`run_worker_error ${error.name}\n`));

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
