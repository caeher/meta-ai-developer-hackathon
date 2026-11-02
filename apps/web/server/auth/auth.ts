import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createDatabaseFromEnvironment, identityFromAuthenticatedSession } from "@meta-game/db";
import { AuthenticationRequiredError } from "./guards";
import { readSessionCookie, SESSION_COOKIE_NAME } from "./core";
import { resolveCurrentUser } from "./service";

export type CurrentUser = { userId: string; email: string };

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? readSessionCookie(cookieStore.toString());
  if (!token) return null;
  const database = createDatabaseFromEnvironment();
  try { return await resolveCurrentUser(database.db, token); }
  finally { await database.close(); }
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthenticationRequiredError();
  return user;
}

export async function requireUser() {
  const user = await requireCurrentUser();
  return identityFromAuthenticatedSession({ userId: user.userId });
}

export async function requirePageUser() {
  try { return await requireUser(); }
  catch (error) {
    if (error instanceof AuthenticationRequiredError) redirect("/sign-in");
    throw error;
  }
}

export { requireProjectOwner, AuthenticationRequiredError } from "./guards";
export type ProjectRepositories = ReturnType<typeof import("@meta-game/db").createRepositories>;
