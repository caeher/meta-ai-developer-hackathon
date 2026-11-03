export function GET(): Response {
  return Response.json({ status: "alive", service: "web" }, { headers: { "cache-control": "no-store" } });
}
