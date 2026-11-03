import "server-only";
import { createDatabaseFromEnvironment, createRepositories, getPreviewTarget, OwnedResourceNotFoundError } from "@meta-game/db";
import { createRedisPreviewStore, loadPreviewKeyRing, parsePreviewBaseDomain } from "@meta-game/preview";
import { AuthenticationRequiredError, requireUser } from "../auth/auth";
import { getAllowedOrigins, getPrimaryAppOrigin } from "../auth/config";
import { apiErrorResponse } from "../auth/http";
import { createPreviewGrantHandlers } from "./handlers";

let previewStore: ReturnType<typeof createRedisPreviewStore> | undefined;

async function preparePreviewViaWorker(userId: string, projectId: string): Promise<void> {
  const rawUrl = process.env.WORKER_INTERNAL_URL;
  const token = process.env.WORKER_INTERNAL_TOKEN;
  if (!rawUrl || !token || token.length < 32 || /placeholder|replace-me|change-me/i.test(token)) return;
  let workerUrl: URL;
  try { workerUrl = new URL(rawUrl); } catch { return; }
  if (!(workerUrl.protocol === "https:" || (workerUrl.protocol === "http:" && ["worker", "localhost", "127.0.0.1"].includes(workerUrl.hostname))) ||
    workerUrl.username || workerUrl.password || workerUrl.search || workerUrl.hash || workerUrl.pathname !== "/") return;
  const endpoint = new URL(`/internal/projects/${encodeURIComponent(projectId)}/preview/prepare`, workerUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ userId }),
    signal: AbortSignal.timeout(9 * 60_000),
  });
  if (!response.ok) throw new Error("preview_prepare_failed");
}

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
    const repositories = createRepositories(database.db);
    const handlers = createPreviewGrantHandlers({
      authenticator: { requireUser: async () => identity },
      projects: repositories.projects,
      target: (projectId) => getPreviewTarget(database!.db, projectId),
      preparePreview: (verifiedIdentity, projectId) => preparePreviewViaWorker(verifiedIdentity.userId, projectId),
      latestRunId: async (verifiedIdentity, projectId) => (await repositories.runs.latest(verifiedIdentity, projectId))?.id,
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
