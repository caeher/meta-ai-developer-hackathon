import {
  OwnedResourceNotFoundError,
  type createRepositories,
  type VerifiedIdentityContext,
} from "@meta-game/db";
import { ProjectNameInputSchema } from "@meta-game/contracts";
import { apiErrorResponse, assertSameOriginRequest, readLimitedJson } from "../auth/http";
import { requireProjectOwner } from "../auth/guards";

type ProjectsRepository = Pick<ReturnType<typeof createRepositories>["projects"], "get" | "rename" | "delete">;
type ProjectRouteContext = { params: Promise<{ projectId: string }> };
type ProjectAuthenticator = { requireUser(): Promise<VerifiedIdentityContext> };

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

        const parsedBody = ProjectNameInputSchema.parse(await readLimitedJson(request));
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

    async DELETE(request: Request, context: ProjectRouteContext): Promise<Response> {
      try {
        assertSameOriginRequest(request, dependencies.allowedOrigins);
        const identity = await dependencies.authenticator.requireUser();
        const { projectId } = await context.params;
        const result = await dependencies.projects.delete(identity, projectId);
        return Response.json(result, {
          status: 202,
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
