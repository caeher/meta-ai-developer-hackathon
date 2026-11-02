import { parseRunEnvironment } from "@meta-game/config";
import { createRunHandlers } from "../../../../../server/projects/run-handlers";
import { withProjectApi } from "../../../../../server/projects/api";

type RouteContext = { params: Promise<{ projectId: string }> };

export function POST(request: Request, context: RouteContext): Promise<Response> {
  return withProjectApi(({ identity, repositories, allowedOrigins }) => {
    const environment = parseRunEnvironment(process.env);
    const handlers = createRunHandlers({
      identity,
      projects: repositories.projects,
      runs: repositories.runs,
      allowedOrigins,
      enabled: environment.RUNS_ENABLED,
      policy: {
        maxConcurrentJobs: environment.USER_MAX_CONCURRENT_JOBS,
        runMaxTokens: environment.RUN_MAX_TOKENS,
        dailyTokenLimit: environment.USER_DAILY_TOKEN_LIMIT,
        dailyImageLimit: environment.USER_DAILY_IMAGE_LIMIT,
      },
    });
    return handlers.POST(request, context);
  });
}
