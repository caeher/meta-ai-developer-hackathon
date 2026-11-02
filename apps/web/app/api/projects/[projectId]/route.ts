import { createProjectHandlers } from "../../../../server/projects/handlers";
import { withProjectApi } from "../../../../server/projects/api";
import { createRedisPreviewStore } from "@meta-game/preview";

type ProjectRouteContext = { params: Promise<{ projectId: string }> };
let previewStore: ReturnType<typeof createRedisPreviewStore> | undefined;

function getPreviewStore() {
  if (!previewStore) previewStore = createRedisPreviewStore(process.env.REDIS_URL ?? "");
  return previewStore;
}

function withProjectHandlers(run: (handlers: ReturnType<typeof createProjectHandlers>) => Promise<Response>): Promise<Response> {
  return withProjectApi(({ identity, repositories, allowedOrigins }) => run(createProjectHandlers({
    authenticator: { requireUser: async () => identity },
    projects: repositories.projects,
    allowedOrigins,
  })));
}

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return withProjectHandlers((handlers) => handlers.GET(request, context));
}

export function PATCH(request: Request, context: ProjectRouteContext): Promise<Response> {
  return withProjectHandlers((handlers) => handlers.PATCH(request, context));
}

export function DELETE(request: Request, context: ProjectRouteContext): Promise<Response> {
  return withProjectApi(({ identity, repositories, allowedOrigins }) => createProjectHandlers({
    authenticator: { requireUser: async () => identity },
    projects: repositories.projects,
    allowedOrigins,
    revokePreviewSessions: (projectId) => getPreviewStore().revokeProject(projectId),
  }).DELETE(request, context));
}
