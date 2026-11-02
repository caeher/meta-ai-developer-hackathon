import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseFromEnvironment,
  createRepositories,
  claimRun,
  finishClaimedRun,
  identityFromAuthenticatedSession,
  ProjectRunBusyError,
  StaleRunWorkerError,
  UsageLimitExceededError,
  projectRunLocks,
  runOutbox,
  runs,
  usageLedger,
  usageReservations,
  reconcileExpiredRunLeases,
  users,
} from "@meta-game/db";
import { pendingOrchestratorHandler, RunProcessingError } from "../../apps/worker/src/handler";
import { startRunWorkerService } from "../../apps/worker/src/queue";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";
const basePolicy = { maxConcurrentJobs: 2, runMaxTokens: 100, dailyTokenLimit: 2_000, dailyImageLimit: 10 };
const queueTimeoutMs = 15_000;

describe.skipIf(!integrationEnabled)("cola durable, cuotas y fencing con PostgreSQL/Redis", () => {
  const createdClerkIds: string[] = [];
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;

  beforeAll(() => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
  });

  afterAll(async () => {
    if (!database) return;
    if (createdClerkIds.length) await database.db.delete(users).where(inArray(users.clerkUserId, createdClerkIds));
    await database.close();
  });

  async function fixture(label: string) {
    const clerkUserId = `user_run${label}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    createdClerkIds.push(clerkUserId);
    const identity = identityFromAuthenticatedSession({ userId: clerkUserId });
    const project = await repositories.projects.create(identity, { name: `Durable run ${label}` });
    return { clerkUserId, identity, project };
  }

  async function waitForRun(runId: string, target: "succeeded" | "failed" | "cancelled", timeoutMs = queueTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [run] = await database.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      if (run?.status === target) return run;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`Run ${runId} did not reach ${target} before timeout`);
  }

  it("crea un solo run, reserva y outbox para reintentos concurrentes con la misma clave", async () => {
    const owner = await fixture("Idempotent");
    const key = `enqueue-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => repositories.runs.enqueueRun(owner.identity, {
      projectId: owner.project.id,
      idempotencyKey: key,
      reservedImages: 1,
      policy: basePolicy,
    })));
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const runId = results[0]!.run.id;
    const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, runId)).limit(1);
    const [outbox] = await database.db.select().from(runOutbox).where(eq(runOutbox.runId, runId)).limit(1);
    expect(reservation).toMatchObject({ reservedTokens: basePolicy.runMaxTokens, reservedImages: 1, status: "reserved" });
    expect(outbox).toMatchObject({ idempotencyKey: key, generation: 0, status: "pending" });
  });

  it("serializa la concurrencia del usuario y del proyecto antes de aceptar otro gasto", async () => {
    const owner = await fixture("Concurrency");
    const secondProject = await repositories.projects.create(owner.identity, { name: "Second concurrency project" });
    const policy = { ...basePolicy, maxConcurrentJobs: 1 };
    const attempts = await Promise.allSettled([
      repositories.runs.enqueueRun(owner.identity, { projectId: owner.project.id, idempotencyKey: `concurrent-a-${randomUUID()}`, policy }),
      repositories.runs.enqueueRun(owner.identity, { projectId: secondProject.id, idempotencyKey: `concurrent-b-${randomUUID()}`, policy }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(UsageLimitExceededError) });
    if (rejected?.status === "rejected") expect(rejected.reason.limit).toBe("concurrency");

    const second = await fixture("ProjectBusy");
    await repositories.runs.enqueueRun(second.identity, { projectId: second.project.id, idempotencyKey: `project-first-${randomUUID()}`, policy: basePolicy });
    await expect(repositories.runs.enqueueRun(second.identity, {
      projectId: second.project.id,
      idempotencyKey: `project-second-${randomUUID()}`,
      policy: basePolicy,
    })).rejects.toBeInstanceOf(ProjectRunBusyError);
  });

  it("rechaza una reserva simultánea que excede el saldo diario de tokens", async () => {
    const owner = await fixture("DailyQuota");
    const secondProject = await repositories.projects.create(owner.identity, { name: "Daily quota second project" });
    const policy = { ...basePolicy, maxConcurrentJobs: 5, runMaxTokens: 60, dailyTokenLimit: 100 };
    const attempts = await Promise.allSettled([
      repositories.runs.enqueueRun(owner.identity, { projectId: owner.project.id, idempotencyKey: `quota-a-${randomUUID()}`, policy }),
      repositories.runs.enqueueRun(owner.identity, { projectId: secondProject.id, idempotencyKey: `quota-b-${randomUUID()}`, policy }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(UsageLimitExceededError) });
    if (rejected?.status === "rejected") expect(rejected.reason.limit).toBe("tokens");
  });

  it("reserva imágenes contra el límite diario sin permitir una carrera entre proyectos", async () => {
    const owner = await fixture("ImageQuota");
    const secondProject = await repositories.projects.create(owner.identity, { name: "Image quota second project" });
    const policy = { ...basePolicy, maxConcurrentJobs: 5, runMaxTokens: 10, dailyImageLimit: 1 };
    const attempts = await Promise.allSettled([
      repositories.runs.enqueueRun(owner.identity, { projectId: owner.project.id, idempotencyKey: `image-a-${randomUUID()}`, reservedImages: 1, policy }),
      repositories.runs.enqueueRun(owner.identity, { projectId: secondProject.id, idempotencyKey: `image-b-${randomUUID()}`, reservedImages: 1, policy }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(UsageLimitExceededError) });
    if (rejected?.status === "rejected") expect(rejected.reason.limit).toBe("images");
  });

  it("cancela un run en cola y libera su reserva en la misma transacción", async () => {
    const owner = await fixture("CancelQueued");
    const created = await repositories.runs.enqueueRun(owner.identity, {
      projectId: owner.project.id,
      idempotencyKey: `cancel-${randomUUID()}`,
      policy: basePolicy,
    });
    const cancelled = await repositories.runs.cancelRun(owner.identity, created.run.id);
    const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, created.run.id)).limit(1);
    const [outbox] = await database.db.select().from(runOutbox).where(eq(runOutbox.runId, created.run.id)).limit(1);
    expect(cancelled?.status).toBe("cancelled");
    expect(reservation?.status).toBe("released");
    expect(outbox?.status).toBe("dispatched");
    await expect(repositories.runs.cancelRun(identityFromAuthenticatedSession({ userId: "user_runOther0001" }), created.run.id))
      .rejects.toThrow("Recurso no encontrado");
  });

  it("reconcilia un lease vencido, sube fencing y rechaza escrituras del worker antiguo", async () => {
    const owner = await fixture("LeaseFence");
    const created = await repositories.runs.enqueueRun(owner.identity, {
      projectId: owner.project.id,
      idempotencyKey: `lease-${randomUUID()}`,
      policy: basePolicy,
    });
    const payload = { runId: created.run.id, idempotencyKey: created.run.idempotencyKey, generation: 0 };
    const first = await claimRun(database.db, { ...payload, leaseMs: 3_000 });
    expect(first).toBeDefined();
    expect(await claimRun(database.db, { ...payload, leaseMs: 3_000 })).toBeUndefined();
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_100));
    expect(await reconcileExpiredRunLeases(database.db)).toBe(1);
    await expect(finishClaimedRun(database.db, first!.claim, { status: "succeeded", usage: { tokens: 1, images: 0 } }))
      .rejects.toBeInstanceOf(StaleRunWorkerError);
    await expect(claimRun(database.db, { ...payload, leaseMs: 3_000 })).resolves.toBeUndefined();
    const [outbox] = await database.db.select().from(runOutbox).where(eq(runOutbox.runId, created.run.id)).limit(1);
    expect(outbox?.generation).toBe(1);
    const second = await claimRun(database.db, { ...payload, generation: 1, leaseMs: 3_000 });
    expect(second?.claim.fencingToken).toBeGreaterThan(first!.claim.fencingToken);
    await finishClaimedRun(database.db, second!.claim, { status: "succeeded", usage: { tokens: 12, images: 0 } });
    const [finished] = await database.db.select().from(runs).where(eq(runs.id, created.run.id)).limit(1);
    const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, created.run.id)).limit(1);
    const charges = await database.db.select().from(usageLedger).where(eq(usageLedger.reservationId, reservation!.id));
    expect(finished?.status).toBe("succeeded");
    expect(reservation?.status).toBe("committed");
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ kind: "charge", tokens: 12, images: 0 });
  });

  it("publica el outbox en Redis y procesa el run una sola vez con consumo durable", async () => {
    const owner = await fixture("RedisQueue");
    const queueName = `run-it-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const service = startRunWorkerService({
      database: database.db,
      redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      queueName,
      leaseMs: 3_000,
      pollIntervalMs: 25,
      handler: async () => ({ usage: { tokens: 9, images: 0 } }),
    });
    try {
      const created = await repositories.runs.enqueueRun(owner.identity, {
        projectId: owner.project.id,
        idempotencyKey: `redis-${randomUUID()}`,
        policy: basePolicy,
      });
      const finished = await waitForRun(created.run.id, "succeeded");
      const [outbox] = await database.db.select().from(runOutbox).where(eq(runOutbox.runId, created.run.id)).limit(1);
      const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, created.run.id)).limit(1);
      const charges = await database.db.select().from(usageLedger).where(eq(usageLedger.reservationId, reservation!.id));
      expect(finished.status).toBe("succeeded");
      expect(outbox?.status).toBe("dispatched");
      expect(charges).toHaveLength(1);
      expect(charges[0]?.tokens).toBe(9);
    } finally {
      await service.close();
    }
  });

  it("propaga la cancelación activa por heartbeat y registra el consumo ya realizado", async () => {
    const owner = await fixture("CancelActive");
    const queueName = `run-cancel-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const service = startRunWorkerService({
      database: database.db,
      redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      queueName,
      leaseMs: 3_000,
      pollIntervalMs: 25,
      handler: async (_run, { signal }) => new Promise((resolveResult) => {
        const result = { usage: { tokens: 7, images: 0 } };
        if (signal.aborted) resolveResult(result);
        else signal.addEventListener("abort", () => resolveResult(result), { once: true });
      }),
    });
    try {
      const created = await repositories.runs.enqueueRun(owner.identity, {
        projectId: owner.project.id,
        idempotencyKey: `active-cancel-${randomUUID()}`,
        policy: basePolicy,
      });
      const deadline = Date.now() + queueTimeoutMs;
      let isRunning = false;
      while (Date.now() < deadline && !isRunning) {
        const [run] = await database.db.select().from(runs).where(eq(runs.id, created.run.id)).limit(1);
        isRunning = run?.status === "running";
        if (!isRunning) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(isRunning).toBe(true);
      const requested = await repositories.runs.cancelRun(owner.identity, created.run.id);
      expect(requested?.cancelRequestedAt).not.toBeNull();
      const cancelled = await waitForRun(created.run.id, "cancelled");
      const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, created.run.id)).limit(1);
      const charges = await database.db.select().from(usageLedger).where(eq(usageLedger.reservationId, reservation!.id));
      expect(cancelled.status).toBe("cancelled");
      expect(reservation?.status).toBe("committed");
      expect(charges).toHaveLength(1);
      expect(charges[0]?.tokens).toBe(7);
    } finally {
      await service.close();
    }
  });

  it("deja visible orchestrator_pending y libera la retención de producto", async () => {
    const owner = await fixture("PendingHandler");
    const queueName = `run-pending-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const service = startRunWorkerService({
      database: database.db,
      redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      queueName,
      leaseMs: 3_000,
      pollIntervalMs: 25,
      handler: pendingOrchestratorHandler,
    });
    try {
      const created = await repositories.runs.enqueueRun(owner.identity, {
        projectId: owner.project.id,
        idempotencyKey: `pending-${randomUUID()}`,
        policy: basePolicy,
      });
      const failed = await waitForRun(created.run.id, "failed");
      const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, created.run.id)).limit(1);
      expect(failed.errorCode).toBe("orchestrator_pending");
      expect(reservation?.status).toBe("released");
    } finally {
      await service.close();
    }
  });

  it("limita los retries transitorios y deja fallo visible al agotarse", async () => {
    const owner = await fixture("Retries");
    const queueName = `run-retry-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    let attempts = 0;
    const service = startRunWorkerService({
      database: database.db,
      redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      queueName,
      leaseMs: 3_000,
      pollIntervalMs: 25,
      handler: async () => {
        attempts += 1;
        throw new RunProcessingError("temporary_failure", true);
      },
    });
    try {
      const created = await repositories.runs.enqueueRun(owner.identity, {
        projectId: owner.project.id,
        idempotencyKey: `retry-${randomUUID()}`,
        policy: basePolicy,
      });
      const failed = await waitForRun(created.run.id, "failed");
      const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, created.run.id)).limit(1);
      expect(attempts).toBe(3);
      expect(failed.errorCode).toBe("worker_retries_exhausted");
      expect(reservation?.status).toBe("released");
    } finally {
      await service.close();
    }
  });

  it("sobrevive a muerte y reinicio del worker con Redis/Postgres reales", async () => {
    const owner = await fixture("CrashRestart");
    const queueName = `run-crash-${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const created = await repositories.runs.enqueueRun(owner.identity, {
      projectId: owner.project.id,
      idempotencyKey: `crash-${randomUUID()}`,
      policy: basePolicy,
    });
    const child = spawn(process.execPath, ["--import", "tsx", resolve("tests/integration/worker-crash-child.ts")], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
        TEST_RUN_QUEUE_NAME: queueName,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let childOutput = "";
    child.stdout.on("data", (chunk: Buffer) => { childOutput += chunk.toString(); });
    child.stderr.on("data", () => undefined);
    try {
      await waitForChildMarker(child, () => childOutput.includes("RUN_HANDLER_STARTED"), 10_000);
      child.kill("SIGKILL");
      await waitForChildExit(child);

      const restarted = startRunWorkerService({
        database: database.db,
        redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
        queueName,
        leaseMs: 3_000,
        pollIntervalMs: 25,
        handler: async () => ({ usage: { tokens: 21, images: 0 } }),
      });
      try {
        const finished = await waitForRun(created.run.id, "succeeded", 20_000);
        const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, created.run.id)).limit(1);
        const [lock] = await database.db.select().from(projectRunLocks).where(and(
          eq(projectRunLocks.ownerUserId, created.run.ownerUserId),
          eq(projectRunLocks.projectId, created.run.projectId),
        )).limit(1);
        const charges = await database.db.select().from(usageLedger).where(eq(usageLedger.reservationId, reservation!.id));
        expect(finished.status).toBe("succeeded");
        expect(lock?.fencingToken).toBeGreaterThan(1);
        expect(charges).toHaveLength(1);
        expect(charges[0]?.tokens).toBe(21);
      } finally {
        await restarted.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await waitForChildExit(child);
    }
  });
});

function waitForChildMarker(child: ChildProcess, predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => finish(new Error("Test worker did not start")), timeoutMs);
    const poll = setInterval(() => {
      if (predicate()) finish();
      else if (child.exitCode !== null || child.signalCode !== null) finish(new Error("Test worker exited before claiming a run"));
    }, 25);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      clearInterval(poll);
      if (error) rejectWait(error);
      else resolveWait();
    };
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveWait) => child.once("exit", () => resolveWait()));
}
