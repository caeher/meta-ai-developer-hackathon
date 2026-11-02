import { AuthenticationRequiredError } from "../../../../../server/auth/guards";
import { requireUser } from "../../../../../server/auth/auth";
import { withProjectApi } from "../../../../../server/projects/api";
import { createRunEventsHandler } from "../../../../../server/projects/run-events-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ runId: string }> };

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return withProjectApi(({ identity, repositories }) => createRunEventsHandler({
    identity,
    runs: repositories.runs,
    validateSession: async () => {
      const currentIdentity = await requireUser();
      if (currentIdentity.userId !== identity.userId) throw new AuthenticationRequiredError();
    },
  })(request, context));
}
