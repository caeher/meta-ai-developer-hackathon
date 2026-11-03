import { EnqueueRunRequestSchema, RunResponseSchema } from "@meta-game/contracts";
import type { RunQuotaPolicy, VerifiedIdentityContext } from "@meta-game/db";
import { apiErrorResponse, assertSameOriginRequest, readLimitedJson } from "../auth/http";
import { isOpaqueTelemetryId, newRequestId, withTelemetryContext } from "@meta-game/config";
import { webLogger } from "../observability";

interface RunProjectLookup {
  get(identity: VerifiedIdentityContext, projectId: string): Promise<unknown | undefined>;
}

interface RunRepository {
  requireContributorConsent(identity: VerifiedIdentityContext): Promise<void>;
  enqueueRun(identity: VerifiedIdentityContext, input: {
    projectId: string;
    idempotencyKey: string;
    messageRequestId: string;
    policy: RunQuotaPolicy;
  }): Promise<{ run: { id: string; projectId: string; status: string; errorCode: string | null; cancelRequestedAt: Date | null; createdAt: Date; updatedAt: Date }; created: boolean }>;
  get(identity: VerifiedIdentityContext, runId: string): Promise<{ id: string; projectId: string; status: string; errorCode: string | null; cancelRequestedAt: Date | null; createdAt: Date; updatedAt: Date } | undefined>;
  latest(identity: VerifiedIdentityContext, projectId: string): Promise<{ id: string; projectId: string; status: string; errorCode: string | null; cancelRequestedAt: Date | null; createdAt: Date; updatedAt: Date; sourceMessageRequestId?: string } | undefined>;
  cancelRun(identity: VerifiedIdentityContext, runId: string): Promise<{ id: string; projectId: string; status: string; errorCode: string | null; cancelRequestedAt: Date | null; createdAt: Date; updatedAt: Date }>;
}

function toRunResponse(run: {
  id: string;
  projectId: string;
  status: string;
  errorCode: string | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return RunResponseSchema.parse({
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    errorCode: run.errorCode,
    cancelRequested: run.cancelRequestedAt !== null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  });
}

export function createRunHandlers(options: {
  identity: VerifiedIdentityContext;
  projects: RunProjectLookup;
  runs: RunRepository;
  allowedOrigins: readonly string[];
  enabled: boolean;
  policy: RunQuotaPolicy;
}) {
  return {
    async latest(_request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      try {
        const { projectId } = await context.params;
        const project = await options.projects.get(options.identity, projectId);
        if (!project) return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
        const run = await options.runs.latest(options.identity, projectId);
        return Response.json({
          run: run ? toRunResponse(run) : null,
          sourceMessageRequestId: run?.sourceMessageRequestId ?? null,
          enabled: options.enabled,
        }, { headers: privateHeaders });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },

    async POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      const candidateRequestId = request.headers.get("x-request-id");
      const requestId = isOpaqueTelemetryId(candidateRequestId) ? candidateRequestId : newRequestId();
      return withTelemetryContext({ requestId }, async () => {
      try {
        assertSameOriginRequest(request, options.allowedOrigins);
        const body = EnqueueRunRequestSchema.parse(await readLimitedJson(request, 4 * 1024));
        const { projectId } = await context.params;
        const project = await options.projects.get(options.identity, projectId);
        if (!project) return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
        if (!options.enabled) {
          return Response.json({ error: "orchestrator_pending" }, { status: 503, headers: privateHeaders });
        }
        if (!body.messageRequestId) {
          return Response.json({ error: "message_required" }, { status: 400, headers: privateHeaders });
        }
        await options.runs.requireContributorConsent(options.identity);
        const result = await options.runs.enqueueRun(options.identity, {
          projectId,
          idempotencyKey: body.idempotencyKey,
          messageRequestId: body.messageRequestId,
          policy: options.policy,
        });
        withTelemetryContext({ requestId, runId: result.run.id }, () => webLogger.info("run.enqueued", { outcome: result.created ? "created" : "duplicate" }));
        return Response.json({ run: toRunResponse(result.run), duplicate: !result.created }, { status: result.created ? 202 : 200, headers: privateHeaders });
      } catch (error) {
        return apiErrorResponse(error);
      }
      });
    },

    async GET(_request: Request, context: { params: Promise<{ projectId: string; runId: string }> }): Promise<Response> {
      try {
        const { projectId, runId } = await context.params;
        const project = await options.projects.get(options.identity, projectId);
        if (!project) return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
        const result = await options.runs.get(options.identity, runId);
        if (!result || result.projectId !== projectId) return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
        return Response.json({ run: toRunResponse(result) }, { headers: privateHeaders });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },

    async DELETE(request: Request, context: { params: Promise<{ projectId: string; runId: string }> }): Promise<Response> {
      try {
        assertSameOriginRequest(request, options.allowedOrigins);
        const { projectId, runId } = await context.params;
        const project = await options.projects.get(options.identity, projectId);
        if (!project) return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
        const ownedRun = await options.runs.get(options.identity, runId);
        if (!ownedRun || ownedRun.projectId !== projectId) return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
        const run = await options.runs.cancelRun(options.identity, runId);
        return Response.json({ run: toRunResponse(run) }, { headers: privateHeaders });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}

const privateHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
