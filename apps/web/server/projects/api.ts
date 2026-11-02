import "server-only";
import { createDatabaseFromEnvironment, createRepositories } from "@meta-game/db";
import { parseRunEnvironment } from "@meta-game/config";
import type { VerifiedIdentityContext } from "@meta-game/db";
import { apiErrorResponse } from "../auth/http";
import { requireUser } from "../auth/auth";
import { getAllowedOrigins } from "../auth/config";

export interface ProjectApiContext {
  identity: VerifiedIdentityContext;
  repositories: ReturnType<typeof createRepositories>;
  allowedOrigins: readonly string[];
}

export async function withProjectApi(action: (context: ProjectApiContext) => Promise<Response>): Promise<Response> {
  let database: ReturnType<typeof createDatabaseFromEnvironment> | undefined;
  let databaseTransferredToStream = false;
  try {
    const identity = await requireUser();
    database = createDatabaseFromEnvironment();
    const quotas = parseRunEnvironment(process.env);
    const response = await action({ identity, repositories: createRepositories(database.db, {
      maxProjects: quotas.USER_MAX_PROJECTS,
      maxStorageBytes: quotas.USER_MAX_STORAGE_MB * 1024 * 1024,
      maxConcurrentJobs: quotas.USER_MAX_CONCURRENT_JOBS,
      runMaxTokens: quotas.RUN_MAX_TOKENS,
      dailyTokenLimit: quotas.USER_DAILY_TOKEN_LIMIT,
      dailyImageLimit: quotas.USER_DAILY_IMAGE_LIMIT,
      runMaxDurationMs: quotas.RUN_MAX_DURATION_MS,
    }), allowedOrigins: getAllowedOrigins() });
    if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") && response.body && database) {
      const reader = response.body.getReader();
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await database?.close();
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              await release();
            } else {
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            controller.error(error);
            await release();
          }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); }
          finally { await release(); }
        },
      }, { highWaterMark: 1 });
      databaseTransferredToStream = true;
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  } finally {
    if (!databaseTransferredToStream) await database?.close();
  }
}
