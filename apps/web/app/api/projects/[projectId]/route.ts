import "server-only";
import { createDatabaseFromEnvironment, createRepositories } from "@meta-game/db";
import { apiErrorResponse } from "../../../../server/auth/http";
import { requireUser } from "../../../../server/auth/auth";
import { getClerkConfiguration } from "../../../../server/auth/config";
import { createProjectHandlers } from "../../../../server/projects/handlers";

type ProjectRouteContext = { params: Promise<{ projectId: string }> };

async function withProjectHandlers(
  run: (handlers: ReturnType<typeof createProjectHandlers>) => Promise<Response>,
): Promise<Response> {
  const clerkConfiguration = getClerkConfiguration();
  if (!clerkConfiguration.configured) {
    return Response.json(
      { error: "authentication_not_configured" },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }

  let database: ReturnType<typeof createDatabaseFromEnvironment> | undefined;
  try {
    const identity = await requireUser();
    database = createDatabaseFromEnvironment();
    const repositories = createRepositories(database.db);
    const handlers = createProjectHandlers({
      authenticator: { requireUser: async () => identity },
      projects: repositories.projects,
      allowedOrigins: clerkConfiguration.authorizedParties,
    });
    return await run(handlers);
  } catch (error) {
    return apiErrorResponse(error);
  } finally {
    await database?.close();
  }
}

export function GET(request: Request, context: ProjectRouteContext): Promise<Response> {
  return withProjectHandlers((handlers) => handlers.GET(request, context));
}

export function PATCH(request: Request, context: ProjectRouteContext): Promise<Response> {
  return withProjectHandlers((handlers) => handlers.PATCH(request, context));
}
