import "server-only";
import { createProjectCollectionHandlers } from "../../../server/projects/collection-handlers";
import { withProjectApi } from "../../../server/projects/api";

export function GET(request: Request): Promise<Response> {
  return withProjectApi(({ identity, repositories, allowedOrigins }) =>
    createProjectCollectionHandlers({ identity, projects: repositories.projects, allowedOrigins }).GET(request));
}

export function POST(request: Request): Promise<Response> {
  return withProjectApi(({ identity, repositories, allowedOrigins }) =>
    createProjectCollectionHandlers({ identity, projects: repositories.projects, allowedOrigins }).POST(request));
}
