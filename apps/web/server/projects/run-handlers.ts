import { EnqueueRunRequestSchema, RunResponseSchema } from "@meta-game/contracts";
import type { RunQuotaPolicy, VerifiedIdentityContext } from "@meta-game/db";
import { apiErrorResponse, assertSameOriginRequest, readLimitedJson } from "../auth/http";

interface RunProjectLookup {
  get(identity: VerifiedIdentityContext, projectId: string): Promise<unknown | undefined>;
}

interface RunRepository {
  enqueueRun(identity: VerifiedIdentityContext, input: {
    projectId: string;
    idempotencyKey: string;
    messageRequestId: string;
    contributorConsent: true;
    policy: RunQuotaPolicy;
  }): Promise<{ run: { id: string; projectId: string; status: string; errorCode: string | null; cancelRequestedAt: Date | null; createdAt: Date; updatedAt: Date }; created: boolean }>;
  get(identity: VerifiedIdentityContext, runId: string): Promise<{ id: string; projectId: string; status: string; errorCode: string | null; cancelRequestedAt: Date | null; createdAt: Date; updatedAt: Date } | undefined>;
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
    async POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      try {
        assertSameOriginRequest(request, options.allowedOrigins);
        const body = EnqueueRunRequestSchema.parse(await readLimitedJson(request, 4 * 1024));
        const { projectId } = await context.params;
        const project = await options.projects.get(options.identity, projectId);
        if (!project) return Response.json({ error: "not_found" }, { status: 404, headers: privateHeaders });
        if (!options.enabled) {
          return Response.json({ error: "orchestrator_pending" }, { status: 503, headers: privateHeaders });
        }
        if (!body.messageRequestId || body.contributorConsent !== true) {
          return Response.json({ error: !body.messageRequestId ? "message_required" : "contributor_consent_required" }, { status: 400, headers: privateHeaders });
        }
        const result = await options.runs.enqueueRun(options.identity, {
          projectId,
          idempotencyKey: body.idempotencyKey,
          messageRequestId: body.messageRequestId,
          contributorConsent: true,
          policy: options.policy,
        });
        return Response.json({ run: toRunResponse(result.run), duplicate: !result.created }, { status: result.created ? 202 : 200, headers: privateHeaders });
      } catch (error) {
        return apiErrorResponse(error);
      }
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
