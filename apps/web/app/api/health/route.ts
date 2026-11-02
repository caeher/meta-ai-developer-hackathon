import { HealthResponseSchema } from "@meta-game/contracts";

export function GET(): Response {
  const body = HealthResponseSchema.parse({
    status: "ok",
    service: "web",
  });

  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
