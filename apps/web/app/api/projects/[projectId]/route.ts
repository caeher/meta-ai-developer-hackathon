import { createProjectHandlers } from "../../../../server/projects/handlers";
import { withProjectApi } from "../../../../server/projects/api";

type ProjectRouteContext = { params: Promise<{ projectId: string }> };

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
  return withProjectHandlers((handlers) => handlers.DELETE(request, context));
}
