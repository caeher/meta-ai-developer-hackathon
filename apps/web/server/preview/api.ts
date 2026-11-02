import "server-only";
import { createDatabaseFromEnvironment, createRepositories, getPreviewTarget, OwnedResourceNotFoundError } from "@meta-game/db";
import { createRedisPreviewStore, loadPreviewKeyRing, parsePreviewBaseDomain } from "@meta-game/preview";
import { AuthenticationRequiredError, requireUser } from "../auth/auth";
import { getAllowedOrigins, getPrimaryAppOrigin } from "../auth/config";
import { apiErrorResponse } from "../auth/http";
import { createPreviewGrantHandlers } from "./handlers";

let previewStore: ReturnType<typeof createRedisPreviewStore> | undefined;

function getStore() {
  if (!previewStore) previewStore = createRedisPreviewStore(process.env.REDIS_URL ?? "");
  return previewStore;
}

export async function withPreviewGrantHandler(
  action: (handlers: ReturnType<typeof createPreviewGrantHandlers>) => Promise<Response>,
): Promise<Response> {
  const baseDomain = parsePreviewBaseDomain(process.env.PREVIEW_BASE_DOMAIN);
  let appOrigin: string | undefined;
  let allowedOrigins: string[] = [];
  try {
    appOrigin = getPrimaryAppOrigin();
    allowedOrigins = getAllowedOrigins();
  } catch { /* Invalid origin configuration keeps the preview disabled. */ }
  const keyRing = loadPreviewKeyRing(
    process.env.PREVIEW_TOKEN_KEY_ID,
    process.env.PREVIEW_TOKEN_PRIVATE_KEY,
    process.env.PREVIEW_TOKEN_PUBLIC_KEYS,
  );
  if (process.env.PREVIEW_GATEWAY_ENABLED !== "true" || !baseDomain || !appOrigin || !keyRing || !process.env.REDIS_URL ||
    (process.env.PREVIEW_TOKEN_TTL_SECONDS !== undefined && process.env.PREVIEW_TOKEN_TTL_SECONDS !== "60")) {
    return Response.json({ error: "preview_not_configured" }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" },
    });
  }

  let database: ReturnType<typeof createDatabaseFromEnvironment> | undefined;
  try {
    const identity = await requireUser();
    database = createDatabaseFromEnvironment();
    const handlers = createPreviewGrantHandlers({
      authenticator: { requireUser: async () => identity },
      projects: createRepositories(database.db).projects,
      target: (projectId) => getPreviewTarget(database!.db, projectId),
      store: getStore(),
      keyRing,
      allowedOrigins,
      baseDomain,
    });
    return await action(handlers);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError || error instanceof OwnedResourceNotFoundError) return apiErrorResponse(error);
    return Response.json({ error: "preview_unavailable" }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" },
    });
  } finally {
    await database?.close().catch(() => undefined);
  }
}
