import { createDatabaseFromEnvironment } from "@meta-game/db";

export async function GET(): Promise<Response> {
  let database: ReturnType<typeof createDatabaseFromEnvironment> | undefined;
  try {
    database = createDatabaseFromEnvironment();
    await database.pool.query("SELECT 1");
    return Response.json({ status: "ready", service: "web" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "not_ready", service: "web" }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  } finally {
    await database?.close().catch(() => undefined);
  }
}
