import { withProjectApi } from "../../../../../server/projects/api";
import { createVersionHandlers } from "../../../../../server/projects/version-handlers";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  return withProjectApi((api) => createVersionHandlers(api, {}).list(request, context));
}
