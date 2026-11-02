import "server-only";
import { createDatabaseFromEnvironment, createRepositories } from "@meta-game/db";
import type { VerifiedIdentityContext } from "@meta-game/db";
import { apiErrorResponse } from "../auth/http";
import { requireUser } from "../auth/auth";
import { getClerkConfiguration } from "../auth/config";

export interface ProjectApiContext {
  identity: VerifiedIdentityContext;
  repositories: ReturnType<typeof createRepositories>;
  allowedOrigins: readonly string[];
}

export async function withProjectApi(action: (context: ProjectApiContext) => Promise<Response>): Promise<Response> {
  const clerkConfiguration = getClerkConfiguration();
  if (!clerkConfiguration.configured) {
    return Response.json(
      { error: "authentication_not_configured" },
      { status: 503, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } },
    );
  }
  let database: ReturnType<typeof createDatabaseFromEnvironment> | undefined;
  try {
    const identity = await requireUser();
    database = createDatabaseFromEnvironment();
    return await action({ identity, repositories: createRepositories(database.db), allowedOrigins: clerkConfiguration.authorizedParties });
  } catch (error) {
    return apiErrorResponse(error);
  } finally {
    await database?.close();
  }
}
