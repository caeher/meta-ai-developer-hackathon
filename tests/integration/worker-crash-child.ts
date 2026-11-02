import { createDatabaseFromEnvironment } from "@meta-game/db";
import { startRunWorkerService } from "../../apps/worker/src/queue";

const database = createDatabaseFromEnvironment();
const service = startRunWorkerService({
  database: database.db,
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  queueName: process.env.TEST_RUN_QUEUE_NAME ?? "missing-test-queue-name",
  leaseMs: 3_000,
  pollIntervalMs: 25,
  handler: async () => {
    process.stdout.write("RUN_HANDLER_STARTED\n");
    await new Promise<never>(() => undefined);
  },
});

process.stdout.write("RUN_WORKER_READY\n");
void service;
