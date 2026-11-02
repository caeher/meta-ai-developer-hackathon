import "server-only";
import { createProjectMessageHandlers } from "../../../../../server/projects/message-handlers";
import { withProjectApi } from "../../../../../server/projects/api";

type ProjectRouteContext = { params: Promise<{ projectId: string }> };

function withMessageHandlers(run: (handlers: ReturnType<typeof createProjectMessageHandlers>) => Promise<Response>): Promise<Response> {
  return withProjectApi(({ identity, repositories, allowedOrigins }) => run(createProjectMessageHandlers({
    identity,
    projects: repositories.projects,
    messages: repositories.messages,
    allowedOrigins,
  })));
}

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return withMessageHandlers((handlers) => handlers.GET(request, context));
}

export function POST(request: Request, context: ProjectRouteContext): Promise<Response> {
  return withMessageHandlers((handlers) => handlers.POST(request, context));
}
