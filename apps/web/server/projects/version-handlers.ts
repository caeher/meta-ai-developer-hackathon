import "server-only";
import { z } from "zod";
import type { ProjectApiContext } from "./api";
import { apiErrorResponse, assertSameOriginRequest } from "../auth/http";
import { OwnedResourceNotFoundError } from "@meta-game/db";

type Params = { params: Promise<{ projectId: string; versionId?: string }> };
const UUID = z.string().uuid();

export function createVersionHandlers(context: ProjectApiContext, options: {
  workerUrl?: string;
  workerToken?: string;
  fetcher?: typeof fetch;
}) {
  return {
    async list(_request: Request, { params }: Params) {
      try {
        const { projectId } = await params;
        const project = await context.repositories.projects.get(context.identity, projectId);
        if (!project) throw new OwnedResourceNotFoundError();
        const page = await context.repositories.versions.list(context.identity, projectId, { limit: 50 });
        const items = page.items.map((version) => ({
          id: version.id,
          projectId: version.projectId,
          versionNumber: version.versionNumber,
          runId: version.runId,
          parentVersionId: version.parentVersionId,
          sha256: version.sha256,
          sizeBytes: version.sizeBytes,
          status: version.status,
          createdAt: version.createdAt.toISOString(),
        }));
        return Response.json({ items, latestVersionId: items[0]?.id ?? null, nextCursor: page.nextCursor }, { headers: privateHeaders });
      } catch (error) { return apiErrorResponse(error); }
    },

    async get(_request: Request, { params }: Params) {
      try {
        const { projectId, versionId } = await params;
        const parsed = UUID.safeParse(versionId);
        if (!parsed.success) throw new OwnedResourceNotFoundError();
        const version = await context.repositories.versions.get(context.identity, projectId, parsed.data);
        if (!version) throw new OwnedResourceNotFoundError();
        return Response.json({
          version: {
            id: version.id,
            projectId: version.projectId,
            versionNumber: version.versionNumber,
            runId: version.runId,
            parentVersionId: version.parentVersionId,
            sha256: version.sha256,
            sizeBytes: version.sizeBytes,
            status: version.status,
            createdAt: version.createdAt.toISOString(),
            manifest: version.manifest,
          },
        }, { headers: privateHeaders });
      } catch (error) { return apiErrorResponse(error); }
    },

    async restore(request: Request, { params }: Params) {
      try {
        assertSameOriginRequest(request, context.allowedOrigins);
        const { projectId, versionId } = await params;
        const parsed = UUID.safeParse(versionId);
        if (!parsed.success) throw new OwnedResourceNotFoundError();
        const project = await context.repositories.projects.get(context.identity, projectId);
        const version = await context.repositories.versions.get(context.identity, projectId, parsed.data);
        if (!project || !version) throw new OwnedResourceNotFoundError();
        if (!options.workerUrl || !options.workerToken || options.workerToken.length < 32 || /placeholder|replace-me|change-me/i.test(options.workerToken)) {
          return Response.json({ error: "version_restore_unavailable" }, { status: 503, headers: privateHeaders });
        }
        let workerUrl: URL;
        try { workerUrl = new URL(options.workerUrl); }
        catch { return Response.json({ error: "version_restore_unavailable" }, { status: 503, headers: privateHeaders }); }
        if (!(workerUrl.protocol === "https:" || (workerUrl.protocol === "http:" && ["worker", "localhost", "127.0.0.1"].includes(workerUrl.hostname))) ||
          workerUrl.username || workerUrl.password || workerUrl.search || workerUrl.hash || workerUrl.pathname !== "/") {
          return Response.json({ error: "version_restore_unavailable" }, { status: 503, headers: privateHeaders });
        }
        const endpoint = new URL(`/internal/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(parsed.data)}/restore`, workerUrl);
        const response = await (options.fetcher ?? fetch)(endpoint, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          headers: { authorization: `Bearer ${options.workerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ clerkUserId: context.identity.clerkUserId }),
          signal: AbortSignal.timeout(9 * 60_000),
        });
        if (response.status === 404) throw new OwnedResourceNotFoundError();
        if (response.status === 409) return Response.json({ error: "project_busy" }, { status: 409, headers: privateHeaders });
        if (!response.ok) return Response.json({ error: "version_restore_failed" }, { status: 503, headers: privateHeaders });
        const result = await response.json() as { restored?: { versionId?: unknown; versionNumber?: unknown } };
        if (typeof result.restored?.versionId !== "string" || !Number.isSafeInteger(result.restored.versionNumber)) {
          return Response.json({ error: "version_restore_failed" }, { status: 503, headers: privateHeaders });
        }
        return Response.json({ restored: result.restored }, { headers: privateHeaders });
      } catch (error) { return apiErrorResponse(error); }
    },
  };
}

const privateHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  vary: "Cookie",
};
