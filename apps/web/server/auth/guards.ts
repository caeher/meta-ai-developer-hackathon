import {
  assertVerifiedIdentityContext,
  identityFromAuthenticatedSession,
  OwnedResourceNotFoundError,
  type VerifiedIdentityContext,
} from "@meta-game/db";

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Se requiere una sesión autenticada");
    this.name = "AuthenticationRequiredError";
  }
}

export interface OwnedProjectLookup<Project> {
  get(identity: VerifiedIdentityContext, projectId: string): Promise<Project | undefined>;
}

export function createAuthGuards(resolveSession: () => Promise<{ userId: string | null }>) {
  return {
    async requireUser(): Promise<VerifiedIdentityContext> {
      const session = await resolveSession();
      if (!session.userId) throw new AuthenticationRequiredError();
      try {
        return identityFromAuthenticatedSession({ userId: session.userId });
      } catch {
        throw new AuthenticationRequiredError();
      }
    },

    async requireProjectOwner<Project>(
      identity: VerifiedIdentityContext,
      projectId: string,
      projects: OwnedProjectLookup<Project>,
    ): Promise<Project> {
      assertVerifiedIdentityContext(identity);
      const project = await projects.get(identity, projectId);
      if (!project) throw new OwnedResourceNotFoundError();
      return project;
    },
  };
}

export async function requireProjectOwner<Project>(
  identity: VerifiedIdentityContext,
  projectId: string,
  projects: OwnedProjectLookup<Project>,
): Promise<Project> {
  assertVerifiedIdentityContext(identity);
  const project = await projects.get(identity, projectId);
  if (!project) throw new OwnedResourceNotFoundError();
  return project;
}
