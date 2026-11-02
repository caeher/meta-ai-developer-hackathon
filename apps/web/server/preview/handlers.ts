import { randomUUID, createHash } from "node:crypto";
import {
  PREVIEW_GRANT_AUDIENCE,
  PREVIEW_GRANT_ISSUER,
  PREVIEW_GRANT_TTL_SECONDS,
  PreviewGrantClaimsSchema,
} from "@meta-game/contracts";
import type { VerifiedIdentityContext } from "@meta-game/db";
import type { PreviewKeyRing } from "@meta-game/preview";
import { signPreviewGrant, type PreviewStore } from "@meta-game/preview";
import { AuthenticationRequiredError } from "../auth/guards";
import { OriginValidationError, assertSameOriginRequest } from "../auth/http";

type Authenticator = { requireUser(): Promise<VerifiedIdentityContext> };
type ProjectLookup = { get(identity: VerifiedIdentityContext, projectId: string): Promise<unknown | undefined> };
type PreviewTarget = { ownerClerkUserId: string; sandboxId: string; projectId: string };

const secureHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  vary: "Cookie",
};

function errorResponse(error: unknown): Response {
  let status = 500;
  let code = "preview_unavailable";
  if (error instanceof AuthenticationRequiredError) { status = 401; code = "unauthenticated"; }
  else if (error instanceof OriginValidationError) { status = 403; code = "origin_not_allowed"; }
  else if (error instanceof Error && error.name === "OwnedResourceNotFoundError") { status = 404; code = "not_found"; }
  else if (error instanceof TypeError) { status = 400; code = "invalid_request"; }
  return Response.json({ error: code }, { status, headers: secureHeaders });
}

function rateLimitKey(userId: string, projectId: string): string {
  return createHash("sha256").update(`preview-grant\0${userId}\0${projectId}`).digest("hex");
}

export function createPreviewGrantHandlers(dependencies: {
  authenticator: Authenticator;
  projects: ProjectLookup;
  target(projectId: string): Promise<PreviewTarget | undefined>;
  store: PreviewStore;
  keyRing: PreviewKeyRing;
  allowedOrigins: readonly string[];
  baseDomain: string;
  clock?: () => number;
}) {
  const now = dependencies.clock ?? Date.now;
  return {
    async POST(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      try {
        assertSameOriginRequest(request, dependencies.allowedOrigins);
        const identity = await dependencies.authenticator.requireUser();
        const { projectId } = await context.params;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
          throw new TypeError("invalid_project_id");
        }
        const project = await dependencies.projects.get(identity, projectId);
        if (!project) return Response.json({ error: "not_found" }, { status: 404, headers: secureHeaders });
        const target = await dependencies.target(projectId);
        if (!target || target.projectId !== projectId || target.ownerClerkUserId !== identity.clerkUserId) {
          return Response.json({ error: "preview_unavailable" }, { status: 409, headers: secureHeaders });
        }
        const allowed = await dependencies.store.allowRateLimit(rateLimitKey(identity.clerkUserId, projectId), 60, 60);
        if (!allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: secureHeaders });

        const issuedAt = Math.floor(now() / 1000);
        const claims = PreviewGrantClaimsSchema.parse({
          iss: PREVIEW_GRANT_ISSUER,
          sub: identity.clerkUserId,
          userId: identity.clerkUserId,
          projectId,
          aud: PREVIEW_GRANT_AUDIENCE,
          iat: issuedAt,
          exp: issuedAt + PREVIEW_GRANT_TTL_SECONDS,
          jti: randomUUID(),
          epoch: await dependencies.store.getProjectEpoch(projectId),
        });
        const grant = signPreviewGrant(claims, dependencies.keyRing);
        return Response.json({
          grant,
          previewUrl: `https://${projectId.toLowerCase()}.${dependencies.baseDomain}/`,
          expiresAt: new Date(claims.exp * 1000).toISOString(),
        }, { headers: secureHeaders });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async DELETE(request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> {
      try {
        assertSameOriginRequest(request, dependencies.allowedOrigins);
        const identity = await dependencies.authenticator.requireUser();
        const { projectId } = await context.params;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
          throw new TypeError("invalid_project_id");
        }
        const project = await dependencies.projects.get(identity, projectId);
        if (!project) return Response.json({ error: "not_found" }, { status: 404, headers: secureHeaders });
        await dependencies.store.revokeProject(projectId);
        return new Response(null, { status: 204, headers: secureHeaders });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
