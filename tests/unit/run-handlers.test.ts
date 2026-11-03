import { describe, expect, it, vi } from "vitest";
import { ContributorConsentRequiredError, identityFromAuthenticatedSession } from "@meta-game/db";
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
  const latest = vi.fn<() => Promise<typeof run | undefined>>(async () => run);
  const cancelRun = vi.fn(async () => ({ ...run, status: "cancelled" }));
  const requireContributorConsent = vi.fn(async () => undefined);
  const handlers = createRunHandlers({
    identity,
    projects: { get: async () => input.projectOwned === false ? undefined : ({ id: projectId }) },
    runs: { enqueueRun, get, latest, cancelRun, requireContributorConsent } as never,
    allowedOrigins: ["https://app.example.test"],
    enabled: input.enabled ?? true,
    policy,
  });
  return { handlers, enqueueRun, get, latest, cancelRun, requireContributorConsent };
}

describe("run API handlers", () => {
  it("recupera el run más reciente con ownership y devuelve null si no existe", async () => {
    const { handlers, latest } = makeHandlers();
    const context = { params: Promise.resolve({ projectId }) };
    const found = await handlers.latest(new Request("https://app.example.test/api/projects/runs"), context);
    expect(found.status).toBe(200);
    expect((await found.json()).run.id).toBe(runId);
    expect(latest).toHaveBeenCalledWith(identity, projectId);

    latest.mockResolvedValueOnce(undefined);
    const empty = await handlers.latest(new Request("https://app.example.test/api/projects/runs"), context);
    expect((await empty.json()).run).toBeNull();
  });

  it("no revela el estado de un proyecto ajeno al recuperar el run más reciente", async () => {
    const { handlers, latest } = makeHandlers({ projectOwned: false });
    const response = await handlers.latest(new Request("https://app.example.test/api/projects/runs"), {
      params: Promise.resolve({ projectId }),
    });
    expect(response.status).toBe(404);
    expect(latest).not.toHaveBeenCalled();
  });

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
    const first = await handlers.POST(request("POST", { idempotencyKey: "run-request-003", messageRequestId: "message-request-003", contributorConsent: true }), context);
    enqueueRun.mockResolvedValueOnce({ run, created: false });
    const duplicate = await handlers.POST(request("POST", { idempotencyKey: "run-request-003", messageRequestId: "message-request-003", contributorConsent: true }), context);
    expect(first.status).toBe(202);
    expect((await first.json()).duplicate).toBe(false);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).duplicate).toBe(true);
  });

  it("requires a saved user message before creating an enabled run", async () => {
    const { handlers, enqueueRun } = makeHandlers();
    const response = await handlers.POST(request("POST", { idempotencyKey: "run-request-004" }), {
      params: Promise.resolve({ projectId }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "message_required" });
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("encola sin campo de consentimiento cuando el usuario tiene consentimiento (compatibilidad)", async () => {
    const { handlers, enqueueRun, requireContributorConsent } = makeHandlers();
    const response = await handlers.POST(request("POST", {
      idempotencyKey: "run-request-005",
      messageRequestId: "message-request-005",
    }), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(202);
    expect(requireContributorConsent).toHaveBeenCalledWith(identity);
    expect(enqueueRun).toHaveBeenCalledWith(identity, {
      projectId,
      idempotencyKey: "run-request-005",
      messageRequestId: "message-request-005",
      policy,
    });
  });

  it("ignora el campo contributorConsent del body y deriva del usuario", async () => {
    const { handlers, enqueueRun } = makeHandlers();
    const response = await handlers.POST(request("POST", {
      idempotencyKey: "run-request-006",
      messageRequestId: "message-request-006",
      contributorConsent: true,
    }), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(202);
    const input = enqueueRun.mock.calls.at(0)?.at(1) as unknown as Record<string, unknown>;
    expect(input).not.toHaveProperty("contributorConsent");
    expect(input).toMatchObject({ projectId, idempotencyKey: "run-request-006", messageRequestId: "message-request-006" });
  });

  it("ignora contributorConsent:false de un cliente viejo y deriva del usuario", async () => {
    const { handlers, enqueueRun } = makeHandlers();
    const response = await handlers.POST(request("POST", {
      idempotencyKey: "run-request-009",
      messageRequestId: "message-request-009",
      contributorConsent: false,
    }), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(202);
    const input = enqueueRun.mock.calls.at(0)?.at(1) as unknown as Record<string, unknown>;
    expect(input).not.toHaveProperty("contributorConsent");
  });

  it("rechaza con 403 si no hay consentimiento", async () => {
    const { handlers, enqueueRun, requireContributorConsent } = makeHandlers();
    requireContributorConsent.mockRejectedValueOnce(new ContributorConsentRequiredError());
    const response = await handlers.POST(request("POST", {
      idempotencyKey: "run-request-007",
      messageRequestId: "message-request-007",
    }), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "contributor_consent_required" });
    expect(enqueueRun).not.toHaveBeenCalled();
  });

  it("no duplica ni reserva en un doble intento idempotente sin consentimiento", async () => {
    const { handlers, enqueueRun, requireContributorConsent } = makeHandlers();
    requireContributorConsent.mockRejectedValue(new ContributorConsentRequiredError());
    const context = { params: Promise.resolve({ projectId }) };
    const first = await handlers.POST(request("POST", {
      idempotencyKey: "run-request-008",
      messageRequestId: "message-request-008",
    }), context);
    const second = await handlers.POST(request("POST", {
      idempotencyKey: "run-request-008",
      messageRequestId: "message-request-008",
    }), context);
    expect(first.status).toBe(403);
    expect(second.status).toBe(403);
    expect(enqueueRun).not.toHaveBeenCalled();
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
