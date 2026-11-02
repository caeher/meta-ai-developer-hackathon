import {
  OwnedResourceNotFoundError,
  type createRepositories,
  type VerifiedIdentityContext,
} from "@meta-game/db";
import { z } from "zod";
import { apiErrorResponse, assertSameOriginRequest } from "../auth/http";
import { requireProjectOwner } from "../auth/guards";

type ProjectsRepository = Pick<ReturnType<typeof createRepositories>["projects"], "get" | "rename">;
type ProjectRouteContext = { params: Promise<{ projectId: string }> };
type ProjectAuthenticator = { requireUser(): Promise<VerifiedIdentityContext> };

const renameProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
const maxBodyBytes = 16 * 1024;

async function readLimitedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new TypeError("Se requiere application/json");

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBodyBytes) throw new TypeError("Solicitud demasiado grande");

  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Se requiere un body JSON");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel();
      throw new TypeError("Solicitud demasiado grande");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function projectResponse(project: Awaited<ReturnType<ProjectsRepository["get"]>>) {
  if (!project) throw new OwnedResourceNotFoundError();
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function createProjectHandlers(dependencies: {
  authenticator: ProjectAuthenticator;
  projects: ProjectsRepository;
  allowedOrigins: readonly string[];
}) {
  return {
    async GET(_request: Request, context: ProjectRouteContext): Promise<Response> {
      try {
        const identity = await dependencies.authenticator.requireUser();
        const { projectId } = await context.params;
        const project = await requireProjectOwner(identity, projectId, dependencies.projects);
        return Response.json(projectResponse(project), {
          headers: {
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            vary: "Cookie",
          },
        });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },

    async PATCH(request: Request, context: ProjectRouteContext): Promise<Response> {
      try {
        assertSameOriginRequest(request, dependencies.allowedOrigins);
        const identity = await dependencies.authenticator.requireUser();
        const { projectId } = await context.params;
        await requireProjectOwner(identity, projectId, dependencies.projects);

        const parsedBody = renameProjectSchema.parse(await readLimitedJson(request));
        const updated = await dependencies.projects.rename(identity, projectId, parsedBody.name);
        return Response.json(projectResponse(updated), {
          headers: {
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}
