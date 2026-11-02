import "server-only";
import { createDatabaseFromEnvironment, createRepositories, type VerifiedIdentityContext } from "@meta-game/db";

export async function loadProjects(identity: VerifiedIdentityContext) {
  const database = createDatabaseFromEnvironment();
  try {
    return await createRepositories(database.db).projects.list(identity, { limit: 50 });
  } finally {
    await database.close();
  }
}

export async function loadProjectConversation(identity: VerifiedIdentityContext, projectId: string) {
  const database = createDatabaseFromEnvironment();
  try {
    const repositories = createRepositories(database.db);
    const project = await repositories.projects.get(identity, projectId);
    if (!project) return null;
    const transcript = await repositories.messages.list(identity, projectId, { limit: 50 });
    const versions = await repositories.versions.list(identity, projectId, { limit: 50 });
    return {
      project: { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt },
      transcript,
      versions: versions.items,
    };
  } finally {
    await database.close();
  }
}
