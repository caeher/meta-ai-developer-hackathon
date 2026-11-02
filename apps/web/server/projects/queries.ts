import "server-only";
import { createDatabaseFromEnvironment, createRepositories, type VerifiedIdentityContext } from "@meta-game/db";
import { parseRunEnvironment } from "@meta-game/config";

function repositoriesFor(database: ReturnType<typeof createDatabaseFromEnvironment>) {
  const quotas = parseRunEnvironment(process.env);
  return createRepositories(database.db, {
    maxProjects: quotas.USER_MAX_PROJECTS,
    maxStorageBytes: quotas.USER_MAX_STORAGE_MB * 1024 * 1024,
    maxConcurrentJobs: quotas.USER_MAX_CONCURRENT_JOBS,
    runMaxTokens: quotas.RUN_MAX_TOKENS,
    dailyTokenLimit: quotas.USER_DAILY_TOKEN_LIMIT,
    dailyImageLimit: quotas.USER_DAILY_IMAGE_LIMIT,
    runMaxDurationMs: quotas.RUN_MAX_DURATION_MS,
  });
}

export async function loadProjects(identity: VerifiedIdentityContext) {
  const database = createDatabaseFromEnvironment();
  try {
    return await repositoriesFor(database).projects.list(identity, { limit: 50 });
  } finally {
    await database.close();
  }
}

export async function loadProjectConversation(identity: VerifiedIdentityContext, projectId: string) {
  const database = createDatabaseFromEnvironment();
  try {
    const repositories = repositoriesFor(database);
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

export async function loadUsage(identity: VerifiedIdentityContext) {
  const database = createDatabaseFromEnvironment();
  try { return await repositoriesFor(database).usage.getSummary(identity); }
  finally { await database.close(); }
}
