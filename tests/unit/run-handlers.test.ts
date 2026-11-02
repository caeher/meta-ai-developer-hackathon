import { describe, expect, it, vi } from "vitest";
import { identityFromAuthenticatedSession } from "@meta-game/db";
import { RunQueueJobSchema } from "@meta-game/contracts";
import { createRunHandlers } from "../../apps/web/server/projects/run-handlers";

const projectId = "00000000-0000-4000-8000-000000000111";
const runId = "00000000-0000-4000-8000-000000000222";
const run = {
  id: runId,
  projectId,
  status: "queued",
  errorCode: null,
  cancelRequestedAt: null,
  createdAt: new Date("2026-11-02T10:00:00.000Z"),
  updatedAt: new Date("2026-11-02T10:00:00.000Z"),
};
const policy = { maxConcurrentJobs: 1, runMaxTokens: 100, dailyTokenLimit: 500, dailyImageLimit: 10 };
const identity = identityFromAuthenticatedSession({ userId: "user_runFixture0001" });

function request(method: string, body?: unknown): Request {
  return new Request("https://app.example.test/api/projects/run/runs", {
    method,
    headers: {
      origin: "https://app.example.test",
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function makeHandlers(input: { enabled?: boolean; projectOwned?: boolean } = {}) {
  const enqueueRun = vi.fn(async () => ({ run, created: true }));
  const get = vi.fn(async () => run);
  const cancelRun = vi.fn(async () => ({ ...run, status: "cancelled" }));
  const handlers = createRunHandlers({
    identity,
    projects: { get: async () => input.projectOwned === false ? undefined : ({ id: projectId }) },
    runs: { enqueueRun, get, cancelRun } as never,
    allowedOrigins: ["https://app.example.test"],
    enabled: input.enabled ?? true,
    policy,
  });
  return { handlers, enqueueRun, get, cancelRun };
}

describe("run API handlers", () => {
  it("mantiene el payload de Redis limitado a IDs, clave idempotente y generación", () => {
    expect(RunQueueJobSchema.parse({
      runId,
      idempotencyKey: "run-request-000",
      generation: 0,
    })).toEqual({ runId, idempotencyKey: "run-request-000", generation: 0 });
    expect(RunQueueJobSchema.safeParse({
      runId,
      idempotencyKey: "run-request-000",
      generation: 0,
      prompt: "private user content",
    }).success).toBe(false);
  });

  it("does not enqueue while the orchestrator feature is pending", async () => {
    const { handlers, enqueueRun } = makeHandlers({ enabled: false });
    const response = await handlers.POST(request("POST", { idempotencyKey: "run-request-001" }), {
      params: Promise.resolve({ projectId }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "orchestrator_pending" });
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("checks project ownership before returning the pending capability state", async () => {
    const { handlers, enqueueRun } = makeHandlers({ enabled: false, projectOwned: false });
    const response = await handlers.POST(request("POST", { idempotencyKey: "run-request-002" }), {
      params: Promise.resolve({ projectId }),
    });
    expect(response.status).toBe(404);
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("returns accepted and duplicate statuses for idempotent enqueue", async () => {
    const { handlers, enqueueRun } = makeHandlers();
    const context = { params: Promise.resolve({ projectId }) };
    const first = await handlers.POST(request("POST", { idempotencyKey: "run-request-003" }), context);
    enqueueRun.mockResolvedValueOnce({ run, created: false });
    const duplicate = await handlers.POST(request("POST", { idempotencyKey: "run-request-003" }), context);
    expect(first.status).toBe(202);
    expect((await first.json()).duplicate).toBe(false);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).duplicate).toBe(true);
  });

  it("requires same-origin writes and does not cancel a run through a different project path", async () => {
    const { handlers, cancelRun } = makeHandlers();
    const crossOrigin = new Request("https://app.example.test/api/projects/run/runs", {
      method: "DELETE",
      headers: { origin: "https://attacker.example.test" },
    });
    const rejected = await handlers.DELETE(crossOrigin, { params: Promise.resolve({ projectId, runId }) });
    expect(rejected.status).toBe(403);
    const wrongProject = await handlers.DELETE(request("DELETE"), {
      params: Promise.resolve({ projectId: "00000000-0000-4000-8000-000000000333", runId }),
    });
    expect(wrongProject.status).toBe(404);
    expect(cancelRun).not.toHaveBeenCalled();
  });
});
