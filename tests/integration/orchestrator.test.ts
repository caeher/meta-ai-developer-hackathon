import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendClaimedRunAgentEvents,
  claimRun,
  createDatabaseFromEnvironment,
  createRepositories,
  finishClaimedRun,
  getClaimedRunAgentContext,
  identityFromAuthenticatedSession,
  StaleRunWorkerError,
  transitionClaimedRun,
  runEvents,
  runOutbox,
  usageLedger,
  usageReservations,
  users,
} from "@meta-game/db";
import type { AgentRunEvent, MetaCodeEvent, MetaConversationItem, MetaPlan } from "@meta-game/contracts";
import { createAgentRunHandler } from "../../apps/worker/src/agent/orchestrator";
import type { RunHandlerContext } from "../../apps/worker/src/handler";
import { createPostgresAgentRunStore } from "../../apps/worker/src/agent/store";
import type { AgentSandbox } from "../../apps/worker/src/agent/tools";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";
const model = "muse-spark-1.3-contributor";

describe.skipIf(!integrationEnabled)("orquestador durable con PostgreSQL", () => {
  const clerkUserId = `user_agent${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;

  beforeAll(() => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
  });

  afterAll(async () => {
    if (!database) return;
    await database.db.delete(users).where(inArray(users.clerkUserId, [clerkUserId]));
    await database.close();
  });

  it("liga consentimiento y mensaje, persiste plan antes de write/verify y cobra uso una vez", async () => {
    const identity = identityFromAuthenticatedSession({ userId: clerkUserId });
    const project = await repositories.projects.create(identity, { name: "Agent integration" });
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
      async readFile(_projectId: string, path: string) { return { path, content: '{"scripts":{"test":"vitest run","build":"vite build"}}' }; },
      async writeFile(_projectId: string, path: string, content: string) { return { path, bytesWritten: Buffer.byteLength(content, "utf8") }; },
      async listFiles() { return { path: "", files: [] }; },
      async installDependencies() { return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, truncated: false }; },
      async runCommand(_projectId: string, input: { args: string[] }) { return { stdout: `passed ${input.args.join(" ")}`, stderr: "", exitCode: 0, durationMs: 2, truncated: false }; },
      async startDevServer() { return { status: "ready", port: 4173, leaseExpiresAt: null }; },
      async readLogs() { return { status: "ready", port: 4173, leaseExpiresAt: null, stdout: "", stderr: "" }; },
    } as unknown as AgentSandbox;
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
    const verifyIndex = index("agent.verification");
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(planIndex).toBeLessThan(writeIndex);
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

    const noConsentMessage = await repositories.messages.create(identity, {
      projectId: project.id,
      requestId: `agent-message-${randomUUID()}`,
      role: "user",
      content: "Mensaje sin consentimiento para Contributor.",
    });
    const noConsentRun = await repositories.runs.enqueueRun(identity, {
      projectId: project.id,
      idempotencyKey: `agent-run-${randomUUID()}`,
      messageRequestId: noConsentMessage.requestId,
      policy: { maxConcurrentJobs: 2, runMaxTokens: 20_000, dailyTokenLimit: 30_000, dailyImageLimit: 10 },
    });
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
});
