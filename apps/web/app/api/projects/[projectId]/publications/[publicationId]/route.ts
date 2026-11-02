import { createPublicationHandlers } from "../../../../../../server/projects/publication-handlers";
import { withProjectApi } from "../../../../../../server/projects/api";

type Params = { params: Promise<{ projectId: string; publicationId: string }> };

export async function DELETE(request: Request, context: Params): Promise<Response> {
  return withProjectApi((api) => createPublicationHandlers(api).revoke(request, context));
}
