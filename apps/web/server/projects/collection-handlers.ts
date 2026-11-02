import type { createRepositories } from "@meta-game/db";
import { ProjectNameInputSchema, ProjectPageQuerySchema } from "@meta-game/contracts";
import { apiErrorResponse, assertSameOriginRequest, readLimitedJson } from "../auth/http";
import type { VerifiedIdentityContext } from "@meta-game/db";

type ProjectsRepository = Pick<ReturnType<typeof createRepositories>["projects"], "create" | "list">;

export function createProjectCollectionHandlers(dependencies: {
  identity: VerifiedIdentityContext;
  projects: ProjectsRepository;
  allowedOrigins: readonly string[];
}) {
  return {
    async GET(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        const query = ProjectPageQuerySchema.parse({
          limit: url.searchParams.get("limit") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        const page = await dependencies.projects.list(dependencies.identity, query);
        return Response.json({
          items: page.items.map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt })),
          nextCursor: page.nextCursor,
        }, { headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        assertSameOriginRequest(request, dependencies.allowedOrigins);
        const input = ProjectNameInputSchema.parse(await readLimitedJson(request));
        const project = await dependencies.projects.create(dependencies.identity, input);
        return Response.json(
          { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt },
          { status: 201, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } },
        );
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}
