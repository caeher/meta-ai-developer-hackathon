import "server-only";
import { createDatabaseFromEnvironment, createRepositories, getPreviewTarget, OwnedResourceNotFoundError } from "@meta-game/db";
import { createRedisPreviewStore, loadPreviewKeyRing, parsePreviewBaseDomain } from "@meta-game/preview";
import { AuthenticationRequiredError, requireUser } from "../auth/auth";
import { getClerkConfiguration } from "../auth/config";
import { apiErrorResponse } from "../auth/http";
import { createPreviewGrantHandlers } from "./handlers";

let previewStore: ReturnType<typeof createRedisPreviewStore> | undefined;

function getAppOrigin(): string | undefined {
  const value = process.env.APP_ORIGIN;
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return new Set(["http:", "https:"]).has(url.protocol) && url.origin === value && !url.username && !url.password
      ? url.origin
      : undefined;
  } catch { return undefined; }
}

function getStore() {
  if (!previewStore) previewStore = createRedisPreviewStore(process.env.REDIS_URL ?? "");
  return previewStore;
}

export async function withPreviewGrantHandler(
  action: (handlers: ReturnType<typeof createPreviewGrantHandlers>) => Promise<Response>,
): Promise<Response> {
  let clerkConfigured = false;
  try { clerkConfigured = getClerkConfiguration().configured; }
  catch { /* Invalid Clerk origin configuration keeps preview disabled. */ }
  const baseDomain = parsePreviewBaseDomain(process.env.PREVIEW_BASE_DOMAIN);
  const appOrigin = getAppOrigin();
  const keyRing = loadPreviewKeyRing(
    process.env.PREVIEW_TOKEN_KEY_ID,
    process.env.PREVIEW_TOKEN_PRIVATE_KEY,
    process.env.PREVIEW_TOKEN_PUBLIC_KEYS,
  );
  if (!clerkConfigured || process.env.PREVIEW_GATEWAY_ENABLED !== "true" || !baseDomain || !appOrigin || !keyRing || !process.env.REDIS_URL ||
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
      allowedOrigins: [appOrigin],
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
