import type { createRepositories, VerifiedIdentityContext } from "@meta-game/db";
import { ProjectMessageInputSchema, ProjectMessagePageQuerySchema } from "@meta-game/contracts";
import { OwnedResourceNotFoundError } from "@meta-game/db";
import { apiErrorResponse, assertSameOriginRequest, readLimitedJson } from "../auth/http";

type MessagesRepository = Pick<ReturnType<typeof createRepositories>["messages"], "create" | "list">;
type ProjectsRepository = Pick<ReturnType<typeof createRepositories>["projects"], "get">;
type ProjectRouteContext = { params: Promise<{ projectId: string }> };

function publicMessage(message: Awaited<ReturnType<MessagesRepository["create"]>>) {
  return {
    id: message.id,
    projectId: message.projectId,
    role: message.role,
    content: message.content,
    requestId: message.requestId,
    sequence: message.sequence,
    createdAt: message.createdAt,
  };
}

export function createProjectMessageHandlers(dependencies: {
  identity: VerifiedIdentityContext;
  projects: ProjectsRepository;
  messages: MessagesRepository;
  allowedOrigins: readonly string[];
}) {
  return {
    async GET(request: Request, context: ProjectRouteContext): Promise<Response> {
      try {
        const { projectId } = await context.params;
        const project = await dependencies.projects.get(dependencies.identity, projectId);
        if (!project) throw new OwnedResourceNotFoundError();
        const url = new URL(request.url);
        const query = ProjectMessagePageQuerySchema.parse({
          limit: url.searchParams.get("limit") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        const page = await dependencies.messages.list(dependencies.identity, projectId, query);
        return Response.json({ items: page.items.map(publicMessage), nextCursor: page.nextCursor }, {
          headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", vary: "Cookie" },
        });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },

    async POST(request: Request, context: ProjectRouteContext): Promise<Response> {
      try {
        assertSameOriginRequest(request, dependencies.allowedOrigins);
        const { projectId } = await context.params;
        const project = await dependencies.projects.get(dependencies.identity, projectId);
        if (!project) throw new OwnedResourceNotFoundError();
        const input = ProjectMessageInputSchema.parse(await readLimitedJson(request, 320 * 1024));
        const message = await dependencies.messages.create(dependencies.identity, {
          projectId,
          requestId: input.requestId,
          role: "user",
          content: input.content,
        });
        return Response.json(publicMessage(message), {
          status: 201,
          headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" },
        });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}
