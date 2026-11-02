import { createPublicationHandlers } from "../../../../../server/projects/publication-handlers";
import { withProjectApi } from "../../../../../server/projects/api";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Params): Promise<Response> {
  return withProjectApi((api) => createPublicationHandlers(api).list(request, context));
}

export async function POST(request: Request, context: Params): Promise<Response> {
  return withProjectApi((api) => createPublicationHandlers(api).create(request, context));
}
