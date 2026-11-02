import "server-only";
import { withProjectApi } from "../../../server/projects/api";

export function GET(): Promise<Response> {
  return withProjectApi(async ({ identity, repositories }) => Response.json(
    await repositories.usage.getSummary(identity),
    { headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } },
  ));
}
