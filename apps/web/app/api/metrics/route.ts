import "server-only";
import { webMetrics } from "../../../server/observability";

export function GET(): Response {
  return new Response(webMetrics.render(), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
