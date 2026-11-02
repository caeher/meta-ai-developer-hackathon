import "server-only";
import { z } from "zod";
import { OwnedResourceNotFoundError } from "@meta-game/db";
import { publicationUrl } from "@meta-game/contracts";
import type { ProjectApiContext } from "./api";
import { apiErrorResponse, assertSameOriginRequest } from "../auth/http";

type Params = { params: Promise<{ projectId: string; publicationId?: string }> };
const UUID = z.string().uuid();
const publishInput = z.object({ versionId: UUID, idempotencyKey: z.string().trim().min(8).max(128) }).strict();
const privateHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  vary: "Cookie",
};

export function createPublicationHandlers(context: ProjectApiContext, options: { fetcher?: typeof fetch } = {}) {
  return {
    async list(_request: Request, { params }: Params) {
      try {
        if (!publishingEnabled()) return unavailable();
        const { projectId } = await params;
        const project = await context.repositories.projects.get(context.identity, projectId);
        if (!project) throw new OwnedResourceNotFoundError();
        const page = await context.repositories.publications.list(context.identity, projectId, { limit: 50 });
        const items = page.items.map((publication) => toEditorPublication(publication, projectId, configuredDomain()));
        return Response.json({ items, nextCursor: page.nextCursor }, { headers: privateHeaders });
      } catch (error) { return apiErrorResponse(error); }
    },

    async create(request: Request, { params }: Params) {
      try {
        assertSameOriginRequest(request, context.allowedOrigins);
        if (!publishingEnabled()) return unavailable();
        const { projectId } = await params;
        const project = await context.repositories.projects.get(context.identity, projectId);
        if (!project) throw new OwnedResourceNotFoundError();
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 2_048) return Response.json({ error: "invalid_request" }, { status: 400, headers: privateHeaders });
        let parsedBody: unknown;
        try { parsedBody = JSON.parse(raw); } catch { return Response.json({ error: "invalid_request" }, { status: 400, headers: privateHeaders }); }
        const parsed = publishInput.safeParse(parsedBody);
        if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers: privateHeaders });
        const version = await context.repositories.versions.get(context.identity, projectId, parsed.data.versionId);
        if (!version || version.status !== "ready") throw new OwnedResourceNotFoundError();
        const worker = workerConfig();
        if (!worker) return unavailable();
        const endpoint = new URL(`/internal/projects/${encodeURIComponent(projectId)}/publications`, worker.url);
        const response = await (options.fetcher ?? fetch)(endpoint, {
          method: "POST", redirect: "error", cache: "no-store",
          headers: { authorization: `Bearer ${worker.token}`, "content-type": "application/json" },
          body: JSON.stringify({ userId: context.identity.userId, ...parsed.data }),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 404) throw new OwnedResourceNotFoundError();
        if (response.status === 409) return Response.json({ error: "idempotency_conflict" }, { status: 409, headers: privateHeaders });
        if (!response.ok) return unavailable();
        const payload = await response.json().catch(() => undefined) as { publication?: { id?: unknown } } | undefined;
        const publicationId = UUID.safeParse(payload?.publication?.id);
        if (!publicationId.success) return unavailable();
        const publication = await context.repositories.publications.get(context.identity, projectId, publicationId.data);
        if (!publication) throw new OwnedResourceNotFoundError();
        const listed = await context.repositories.publications.list(context.identity, projectId, { limit: 50 });
        const item = listed.items.find((candidate) => candidate.id === publication.id);
        if (!item) return unavailable();
        return Response.json({ publication: toEditorPublication(item, projectId, configuredDomain()) }, {
          status: publication.status === "published" ? 200 : 202,
          headers: privateHeaders,
        });
      } catch (error) { return apiErrorResponse(error); }
    },

    async revoke(request: Request, { params }: Params) {
      try {
        assertSameOriginRequest(request, context.allowedOrigins);
        if (!publishingEnabled()) return unavailable();
        const { projectId, publicationId: rawId } = await params;
        const project = await context.repositories.projects.get(context.identity, projectId);
        const publicationId = UUID.safeParse(rawId);
        if (!project || !publicationId.success) throw new OwnedResourceNotFoundError();
        const candidate = await context.repositories.publications.get(context.identity, projectId, publicationId.data);
        if (!candidate) throw new OwnedResourceNotFoundError();
        const worker = workerConfig();
        if (!worker) return unavailable();
        const endpoint = new URL(`/internal/projects/${encodeURIComponent(projectId)}/publications/${encodeURIComponent(publicationId.data)}`, worker.url);
        const response = await (options.fetcher ?? fetch)(endpoint, {
          method: "DELETE", redirect: "error", cache: "no-store",
          headers: { authorization: `Bearer ${worker.token}`, "content-type": "application/json" },
          body: JSON.stringify({ userId: context.identity.userId }),
          signal: AbortSignal.timeout(120_000),
        });
        if (response.status === 404) throw new OwnedResourceNotFoundError();
        if (!response.ok) return unavailable();
        const publication = await context.repositories.publications.get(context.identity, projectId, publicationId.data);
        if (!publication) throw new OwnedResourceNotFoundError();
        return Response.json({ revoked: true, id: publication.id }, { headers: privateHeaders });
      } catch (error) { return apiErrorResponse(error); }
    },
  };
}

export function toEditorPublication(publication: {
  id: string; versionId: string; versionNumber: number; status: string; idempotencyKey: string | null;
  artifactSha256: string | null; slug: string; createdAt: Date;
}, projectId: string, domain: string) {
  const status = publication.status === "building" ? "pending" : publication.status === "published" ? "ready" : publication.status;
  return {
    id: publication.id,
    projectId,
    versionId: publication.versionId,
    versionNumber: publication.versionNumber,
    status,
    idempotencyKey: publication.idempotencyKey,
    artifactSha256: publication.artifactSha256,
    url: status === "ready" ? publicationUrl(publication.slug, domain) : null,
    createdAt: publication.createdAt.toISOString(),
  };
}

function configuredDomain(): string { return process.env.PUBLISH_BASE_DOMAIN ?? "games.example.test"; }
function publishingEnabled(): boolean { return process.env.PUBLISHING_ENABLED === "true"; }
function unavailable(): Response { return Response.json({ error: "publishing_unavailable" }, { status: 503, headers: privateHeaders }); }

function workerConfig(): { url: URL; token: string } | undefined {
  const rawUrl = process.env.WORKER_INTERNAL_URL;
  const token = process.env.WORKER_INTERNAL_TOKEN;
  if (!rawUrl || !token || token.length < 32 || /placeholder|replace-me|change-me/i.test(token)) return undefined;
  try {
    const url = new URL(rawUrl);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && ["worker", "localhost", "127.0.0.1"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    return { url, token };
  } catch { return undefined; }
}
