import "server-only";
import { createDatabaseFromEnvironment } from "@meta-game/db";
import { createRedisPreviewStore } from "@meta-game/preview";
import { apiErrorResponse } from "./http";
import { getMailer } from "./mailer";
import { createAuthHandlers } from "./service";

export async function withAuthApi(action: (handlers: ReturnType<typeof createAuthHandlers>) => Promise<Response>): Promise<Response> {
  let database: ReturnType<typeof createDatabaseFromEnvironment> | undefined;
  let previewStore: ReturnType<typeof createRedisPreviewStore> | undefined;
  try {
    database = createDatabaseFromEnvironment();
    if (process.env.PREVIEW_GATEWAY_ENABLED === "true") previewStore = createRedisPreviewStore(process.env.REDIS_URL ?? "");
    return await action(createAuthHandlers({
      database: database.db,
      mailer: getMailer(),
      ...(previewStore ? { revokePreviewSessions: async (projectIds: readonly string[]) => {
        for (const projectId of projectIds) await previewStore!.revokeProject(projectId);
      } } : {}),
    }));
  } catch (error) {
    return apiErrorResponse(error);
  } finally {
    await database?.close().catch(() => undefined);
    await previewStore?.close().catch(() => undefined);
  }
}
