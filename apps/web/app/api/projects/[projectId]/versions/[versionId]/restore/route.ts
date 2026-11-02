import { withProjectApi } from "../../../../../../../server/projects/api";
import { createVersionHandlers } from "../../../../../../../server/projects/version-handlers";

export async function POST(request: Request, context: { params: Promise<{ projectId: string; versionId: string }> }) {
  return withProjectApi((api) => createVersionHandlers(api, {
    workerUrl: process.env.WORKER_INTERNAL_URL,
    workerToken: process.env.WORKER_INTERNAL_TOKEN,
  }).restore(request, context));
}
