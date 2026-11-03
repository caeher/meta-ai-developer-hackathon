import { createHash, randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendClaimedRunAgentEvents,
  claimRun,
  ContributorConsentRequiredError,
  createDatabaseFromEnvironment,
  createRepositories,
  finishClaimedRun,
  getClaimedRunAgentContext,
  identityFromAuthenticatedSession,
  StaleRunWorkerError,
  transitionClaimedRun,
  runEvents,
  runOutbox,
  runs,
  usageLedger,
  usageReservations,
  users,
} from "@meta-game/db";
import type { AgentRunEvent, MetaCodeEvent, MetaConversationItem, MetaPlan } from "@meta-game/contracts";
import { createAgentRunHandler } from "../../apps/worker/src/agent/orchestrator";
import type { AgentCheckpointStorage } from "../../apps/worker/src/agent/orchestrator";
import type { RunHandlerContext } from "../../apps/worker/src/handler";
import { createPostgresAgentRunStore } from "../../apps/worker/src/agent/store";
import type { AgentSandbox } from "../../apps/worker/src/agent/tools";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";
const model = "muse-spark-1.3-contributor";

describe.skipIf(!integrationEnabled)("orquestador durable con PostgreSQL", () => {
  const userId = `user_agent${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const noConsentUserId = `user_agentNoConsent${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;

  beforeAll(() => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
  });

  afterAll(async () => {
    if (!database) return;
    await database.db.delete(users).where(inArray(users.userId, [userId, noConsentUserId]));
    await database.close();
  });

  it("liga consentimiento y mensaje, persiste plan antes de write/verify y cobra uso una vez", async () => {
    const identity = identityFromAuthenticatedSession({ userId: userId });
    const project = await repositories.projects.create(identity, { name: "Agent integration" });
    await database.db.update(users).set({ contributorConsentAt: new Date() }).where(eq(users.userId, userId));
    const message = await repositories.messages.create(identity, {
      projectId: project.id,
      requestId: `agent-message-${randomUUID()}`,
      role: "user",
      content: "Crea una escena Phaser con un jugador y plataformas.",
    });
    const enqueued = await repositories.runs.enqueueRun(identity, {
      projectId: project.id,
      idempotencyKey: `agent-run-${randomUUID()}`,
      messageRequestId: message.requestId,
      contributorConsent: true,
      policy: { maxConcurrentJobs: 2, runMaxTokens: 20_000, dailyTokenLimit: 30_000, dailyImageLimit: 10 },
    });
    const duplicate = await repositories.runs.enqueueRun(identity, {
      projectId: project.id,
      idempotencyKey: enqueued.run.idempotencyKey,
      messageRequestId: message.requestId,
      contributorConsent: true,
      policy: { maxConcurrentJobs: 2, runMaxTokens: 20_000, dailyTokenLimit: 30_000, dailyImageLimit: 10 },
    });
    expect(duplicate).toMatchObject({ created: false, run: { id: enqueued.run.id } });
    const claimed = await claimRun(database.db, {
      runId: enqueued.run.id,
      idempotencyKey: enqueued.run.idempotencyKey,
      generation: 0,
      leaseMs: 15_000,
    });
    expect(claimed).toBeDefined();
    if (!claimed) throw new Error("run was not claimed");
    const claim = claimed.claim;
    await transitionClaimedRun(database.db, claim, "running");
    const agentContext = await getClaimedRunAgentContext(database.db, claim);
    expect(agentContext.prompt).toBe(message.content);

    const plan: MetaPlan = {
      summary: "Crear la escena inicial.",
      objective: "Mostrar un jugador sobre plataformas con física Arcade.",
      steps: [{
        id: "scene",
        title: "Implementar escena",
        description: "Añadir el jugador y las plataformas iniciales.",
        expectedFiles: ["src/game.ts"],
        verifications: ["Ejecutar npm test y npm run build."],
      }],
    };
    const writeCall = {
      type: "tool_call",
      callId: "integration-write-1",
      name: "write_file",
      arguments: { path: "src/game.ts", content: "export const gameReady = true;" },
    } as const;
    const replayWriteCall: MetaConversationItem = {
      kind: "tool_call",
      callId: writeCall.callId,
      name: writeCall.name,
      arguments: writeCall.arguments,
    };
    let codeTurn = 0;
    const meta = {
      async plan() {
        return { plan, model, responseId: "fixture-plan", usage: { inputTokens: 18, outputTokens: 2, totalTokens: 20 } };
      },
      async *streamCode(input: { context?: MetaConversationItem[] }) {
        codeTurn += 1;
        const items = input.context ?? [];
        if (codeTurn === 1) {
          yield writeCall satisfies MetaCodeEvent;
          yield {
            type: "completed",
            responseId: "fixture-code-write",
            model,
            replay: [...items, replayWriteCall, { kind: "message", role: "assistant", text: "La escena ya está creada." }],
            usage: { inputTokens: 28, outputTokens: 2, totalTokens: 30 },
          } satisfies MetaCodeEvent;
          return;
        }
        yield {
          type: "completed",
          responseId: "fixture-code-final",
          model,
          replay: [...items, { kind: "message", role: "assistant", text: "La escena se verificó." }],
          usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        } satisfies MetaCodeEvent;
      },
    } as never;
    const missingSandbox = Object.assign(new Error("not_found"), { code: "not_found" });
    const sandbox = {
      async create() { return { sandboxId: "fixture-sandbox", state: "ready", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), devServer: { status: "stopped", port: null, leaseExpiresAt: null } }; },
      async inspect() { throw missingSandbox; },
      async readFile(_projectId: string, path: string) {
        if (path === ".meta-game-template.json") throw Object.assign(new Error("not_found"), { code: "not_found" });
        return { path, content: '{"scripts":{"test":"vitest run","lint":"tsc --noEmit","build":"vite build"}}' };
      },
      async writeFile(_projectId: string, path: string, content: string) { return { path, bytesWritten: Buffer.byteLength(content, "utf8") }; },
      async listFiles() { return { path: "", files: [] }; },
      async installDependencies() { return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, truncated: false }; },
      async runCommand(_projectId: string, input: { args: string[] }) { return { stdout: `passed ${input.args.join(" ")}`, stderr: "", exitCode: 0, durationMs: 2, truncated: false }; },
      async startDevServer() { return { status: "ready", port: 4173, leaseExpiresAt: null }; },
      async readLogs() { return { status: "ready", port: 4173, leaseExpiresAt: null, stdout: "", stderr: "" }; },
      async verifyGameInteraction() { return { status: "passed", checks: [], consoleErrors: [], blockedRequests: 0 }; },
    } as unknown as AgentSandbox;
    const checkpointBodies = new Map<string, Uint8Array>();
    const checkpoints: AgentCheckpointStorage = {
      async write(identity, body) {
        checkpointBodies.set(identity.runId, body.slice());
        return { sha256: createHash("sha256").update(body).digest("hex"), sizeBytes: body.byteLength };
      },
      async read(identity) {
        const body = checkpointBodies.get(identity.runId);
        if (!body) throw new Error("checkpoint_missing");
        return body;
      },
      async delete(identity) { checkpointBodies.delete(identity.runId); },
    };
    const skills = {
      async routeForRun(input: { runId: string }) {
        return {
          runId: input.runId,
          record: { schemaVersion: 1, runId: input.runId, skills: [], references: [] },
          skills: [], references: [], advisoryNotice: "Contexto consultivo.",
        };
      },
    };
    const handler = createAgentRunHandler({
      store: createPostgresAgentRunStore(database.db),
      meta,
      sandbox,
      checkpoints,
      skills: skills as never,
      maxSteps: 30,
      maxTokens: 16_000,
      maxDurationMs: 30_000,
    });
    const context: RunHandlerContext = {
      signal: new AbortController().signal,
      claim,
      markVerifying: async () => transitionClaimedRun(database.db, claim, "verifying"),
    };

    const result = await handler({ id: enqueued.run.id, projectId: project.id, idempotencyKey: enqueued.run.idempotencyKey }, context);
    await finishClaimedRun(database.db, claim, { status: "succeeded", usage: result.usage });

    const storedEvents = await database.db.select().from(runEvents).where(eq(runEvents.runId, enqueued.run.id)).orderBy(asc(runEvents.sequence));
    const agentEvents = storedEvents.filter((event) => event.type.startsWith("agent."));
    const index = (type: string, predicate: (payload: Record<string, unknown>) => boolean = () => true) =>
      agentEvents.findIndex((event) => event.type === type && predicate(event.payload as Record<string, unknown>));
    const planIndex = index("agent.plan");
    const writeIndex = index("agent.tool_started", (payload) => payload.callId === "integration-write-1");
    const bootstrapCheckIndex = index("agent.verification", (payload) => payload.check === "Phaser template npm test");
    const verifyIndex = agentEvents.findLastIndex((event) => event.type === "agent.verification" &&
      (event.payload as Record<string, unknown>).check === "npm run build");
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeLessThan(bootstrapCheckIndex);
    expect(bootstrapCheckIndex).toBeLessThan(writeIndex);
    expect(writeIndex).toBeLessThan(verifyIndex);
    expect(agentEvents.map((event) => event.type)).toContain("agent.action");
    expect(agentEvents.map((event) => event.type)).toContain("agent.completed");
    expect(result.usage).toEqual({ tokens: 60, images: 0 });

    const [storedOutbox] = await database.db.select().from(runOutbox).where(eq(runOutbox.runId, enqueued.run.id)).limit(1);
    expect(storedOutbox?.runId).toBe(enqueued.run.id);
    const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, enqueued.run.id)).limit(1);
    const charges = await database.db.select().from(usageLedger).where(eq(usageLedger.reservationId, reservation!.id));
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ tokens: 60, images: 0 });

    const retry = await repositories.runs.enqueueRun(identity, {
      projectId: project.id,
      idempotencyKey: `agent-retry-${randomUUID()}`,
      messageRequestId: message.requestId,
      contributorConsent: true,
      policy: { maxConcurrentJobs: 2, runMaxTokens: 20_000, dailyTokenLimit: 30_000, dailyImageLimit: 10 },
    });
    expect(retry.created).toBe(true);
    expect(retry.run.id).not.toBe(enqueued.run.id);
    const latest = await repositories.runs.latest(identity, project.id);
    expect(latest).toMatchObject({ id: retry.run.id, sourceMessageRequestId: message.requestId });
    const originalAgain = await repositories.runs.enqueueRun(identity, {
      projectId: project.id,
      idempotencyKey: enqueued.run.idempotencyKey,
      messageRequestId: message.requestId,
      contributorConsent: true,
      policy: { maxConcurrentJobs: 2, runMaxTokens: 20_000, dailyTokenLimit: 30_000, dailyImageLimit: 10 },
    });
    expect(originalAgain).toMatchObject({ created: false, run: { id: enqueued.run.id } });
    await repositories.runs.cancelRun(identity, retry.run.id);

    await expect(appendClaimedRunAgentEvents(database.db, claim, [{
      type: "agent.completed",
      payload: { summary: "tarde", verification: "passed" },
    } as AgentRunEvent])).rejects.toBeInstanceOf(StaleRunWorkerError);

    const noConsentIdentity = identityFromAuthenticatedSession({ userId: noConsentUserId });
    const noConsentProject = await repositories.projects.create(noConsentIdentity, { name: "Agent sin consentimiento" });
    const noConsentMessage = await repositories.messages.create(noConsentIdentity, {
      projectId: noConsentProject.id,
      requestId: `agent-message-${randomUUID()}`,
      role: "user",
      content: "Mensaje sin consentimiento para Contributor.",
    });
    await expect(repositories.runs.enqueueRun(noConsentIdentity, {
      projectId: noConsentProject.id,
      idempotencyKey: `agent-run-${randomUUID()}`,
      messageRequestId: noConsentMessage.requestId,
      policy: { maxConcurrentJobs: 2, runMaxTokens: 20_000, dailyTokenLimit: 30_000, dailyImageLimit: 10 },
    })).rejects.toThrow(ContributorConsentRequiredError);
    await database.db.update(users).set({ contributorConsentAt: new Date() }).where(eq(users.userId, noConsentUserId));
    const noConsentRun = await repositories.runs.enqueueRun(noConsentIdentity, {
      projectId: noConsentProject.id,
      idempotencyKey: `agent-run-${randomUUID()}`,
      messageRequestId: noConsentMessage.requestId,
      policy: { maxConcurrentJobs: 2, runMaxTokens: 20_000, dailyTokenLimit: 30_000, dailyImageLimit: 10 },
    });
    await database.db.update(runs).set({ contributorConsent: false }).where(eq(runs.id, noConsentRun.run.id));
    const noConsentClaim = await claimRun(database.db, {
      runId: noConsentRun.run.id,
      idempotencyKey: noConsentRun.run.idempotencyKey,
      generation: 0,
      leaseMs: 15_000,
    });
    expect(noConsentClaim).toBeDefined();
    if (!noConsentClaim) throw new Error("consent fixture run was not claimed");
    await expect(getClaimedRunAgentContext(database.db, noConsentClaim.claim))
      .rejects.toThrow("run_contributor_consent_missing");
    await finishClaimedRun(database.db, noConsentClaim.claim, { status: "failed", errorCode: "contributor_consent_required" });
    const [released] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, noConsentRun.run.id)).limit(1);
    expect(released?.status).toBe("released");
  });

  it("reserva cada imagen una sola vez bajo lease y limita la cuota diaria por owner", async () => {
    const identity = identityFromAuthenticatedSession({ userId: userId });
    const project = await repositories.projects.create(identity, { name: "Image quota integration" });
    const message = await repositories.messages.create(identity, {
      projectId: project.id,
      requestId: `image-message-${randomUUID()}`,
      role: "user",
      content: "Genera un sprite de prueba.",
    });
    const enqueued = await repositories.runs.enqueueRun(identity, {
      projectId: project.id,
      idempotencyKey: `image-run-${randomUUID()}`,
      messageRequestId: message.requestId,
      contributorConsent: true,
      policy: { maxConcurrentJobs: 2, runMaxTokens: 20_000, dailyTokenLimit: 30_000, dailyImageLimit: 1 },
    });
    const claimed = await claimRun(database.db, {
      runId: enqueued.run.id,
      idempotencyKey: enqueued.run.idempotencyKey,
      generation: 0,
      leaseMs: 15_000,
    });
    if (!claimed) throw new Error("image quota fixture run was not claimed");
    await transitionClaimedRun(database.db, claimed.claim, "running");

    const store = createPostgresAgentRunStore(database.db);
    await expect(store.identity(claimed.claim)).resolves.toMatchObject({ userId });
    await expect(store.reserveImage(claimed.claim, { requestKey: "image-call-1", round: 1, dailyImageLimit: 1 }))
      .resolves.toBe(true);
    await expect(store.reserveImage(claimed.claim, { requestKey: "image-call-1", round: 1, dailyImageLimit: 1 }))
      .resolves.toBe(false);
    await expect(store.reserveImage(claimed.claim, { requestKey: "image-call-2", round: 1, dailyImageLimit: 1 }))
      .rejects.toMatchObject({ limit: "images" });
    await expect(store.identity({ ...claimed.claim, fencingToken: claimed.claim.fencingToken + 1 }))
      .rejects.toBeInstanceOf(StaleRunWorkerError);

    const storedEvents = await database.db.select().from(runEvents).where(eq(runEvents.runId, enqueued.run.id));
    expect(storedEvents.filter((event) => event.type === "agent.meta_request_started" &&
      (event.payload as Record<string, unknown>).kind === "image")).toHaveLength(1);
    await finishClaimedRun(database.db, claimed.claim, { status: "failed", errorCode: "fixture_ambiguous_image", usage: { tokens: 0, images: 1 } });
    const [reservation] = await database.db.select().from(usageReservations).where(eq(usageReservations.runId, enqueued.run.id)).limit(1);
    const charges = await database.db.select().from(usageLedger).where(eq(usageLedger.reservationId, reservation!.id));
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ tokens: 0, images: 1 });
  });
});
