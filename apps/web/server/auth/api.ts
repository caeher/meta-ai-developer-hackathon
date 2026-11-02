import "server-only";
import { createDatabaseFromEnvironment } from "@meta-game/db";
import { apiErrorResponse } from "./http";
import { getMailer } from "./mailer";
import { createAuthHandlers } from "./service";

export async function withAuthApi(action: (handlers: ReturnType<typeof createAuthHandlers>) => Promise<Response>): Promise<Response> {
  let database: ReturnType<typeof createDatabaseFromEnvironment> | undefined;
  try {
    database = createDatabaseFromEnvironment();
    return await action(createAuthHandlers({ database: database.db, mailer: getMailer() }));
  } catch (error) {
    return apiErrorResponse(error);
  } finally {
    await database?.close().catch(() => undefined);
  }
}
