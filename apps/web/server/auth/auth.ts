import "server-only";
import { auth } from "@clerk/nextjs/server";
import type { createRepositories } from "@meta-game/db";
import { AuthenticationRequiredError, createAuthGuards, requireProjectOwner } from "./guards";

const clerkGuards = createAuthGuards(async () => {
  const session = await auth();
  return { userId: session.userId };
});

export const requireUser = clerkGuards.requireUser;
export { requireProjectOwner, AuthenticationRequiredError };
export type ProjectRepositories = ReturnType<typeof createRepositories>;
