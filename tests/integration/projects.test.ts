import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assets,
  createDatabaseFromEnvironment,
  createRepositories,
  identityFromAuthenticatedSession,
  IdempotencyConflictError,
  OwnedResourceNotFoundError,
  projectCleanupTasks,
  publications,
  runs,
  sandboxes,
  users,
  versions,
} from "@meta-game/db";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";

describe.skipIf(!integrationEnabled)("proyectos privados y chat persistente", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const clerkA = `user_projectA${suffix}`;
  const clerkB = `user_projectB${suffix}`;
  const identityA = identityFromAuthenticatedSession({ userId: clerkA });
  const identityB = identityFromAuthenticatedSession({ userId: clerkB });
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;

  beforeAll(() => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
  });

  afterAll(async () => {
    if (database) {
      await database.db.delete(users).where(inArray(users.clerkUserId, [clerkA, clerkB]));
      await database.close();
    }
  });

  it("crea, pagina, renombra y aísla proyectos entre owners", async () => {
    const first = await repositories.projects.create(identityA, { name: "Primero" });
    const second = await repositories.projects.create(identityA, { name: "Segundo" });
    const foreign = await repositories.projects.create(identityB, { name: "Privado de B" });
    const page = await repositories.projects.list(identityA, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const following = await repositories.projects.list(identityA, { limit: 1, cursor: page.nextCursor! });
    expect(following.items).toHaveLength(1);
    expect([page.items[0]?.id, following.items[0]?.id].sort()).toEqual([first.id, second.id].sort());
    expect(await repositories.projects.get(identityA, foreign.id)).toBeUndefined();
    expect(await repositories.projects.get(identityB, first.id)).toBeUndefined();
    expect((await repositories.projects.rename(identityA, first.id, "Renombrado")).name).toBe("Renombrado");
    expect((await repositories.projects.list(identityB)).items.map((item) => item.id)).toEqual([foreign.id]);
  });

  it("deduplica requestId, detecta conflictos y pagina el transcript en orden estable", async () => {
    const project = await repositories.projects.create(identityA, { name: "Mensajes" });
    const requestId = `request-${suffix}`;
    const first = await repositories.messages.create(identityA, {
      projectId: project.id, requestId, role: "user", content: "Primera idea",
    });
    const repeated = await repositories.messages.create(identityA, {
      projectId: project.id, requestId, role: "user", content: "Primera idea",
    });
    expect(repeated.id).toBe(first.id);
    const concurrentId = `concurrent-${suffix}`;
    const concurrentDuplicates = await Promise.all([1, 2].map(() => repositories.messages.create(identityA, {
      projectId: project.id, requestId: concurrentId, role: "user", content: "Solicitud con reintento concurrente",
    })));
    expect(concurrentDuplicates[0]?.id).toBe(concurrentDuplicates[1]?.id);
    await expect(repositories.messages.create(identityA, {
      projectId: project.id, requestId, role: "user", content: "Otro contenido",
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await repositories.messages.create(identityA, {
      projectId: project.id, requestId: `second-${suffix}`, role: "user", content: "Segunda idea",
    });
    await repositories.messages.create(identityA, {
      projectId: project.id, requestId: `third-${suffix}`, role: "assistant", content: "Respuesta guardada",
    });

    const latest = await repositories.messages.list(identityA, project.id, { limit: 2 });
    expect(latest.items.map((message) => message.sequence)).toEqual([3, 4]);
    expect(latest.items.map((message) => message.content)).toEqual(["Segunda idea", "Respuesta guardada"]);
    expect(latest.nextCursor).not.toBeNull();
    const earlier = await repositories.messages.list(identityA, project.id, { limit: 2, cursor: latest.nextCursor! });
    expect(earlier.items.map((message) => message.sequence)).toEqual([1, 2]);
    await expect(repositories.messages.list(identityB, project.id)).rejects.toThrow("Recurso no encontrado");
  });

  it("elimina lógicamente y pone recursos relacionados en cola sin reactivar operaciones", async () => {
    const project = await repositories.projects.create(identityA, { name: "Para borrar" });
    const run = await repositories.runs.create(identityA, { projectId: project.id, idempotencyKey: `delete-run-${suffix}` });
    const sandbox = await repositories.sandboxes.upsert(identityA, { projectId: project.id, status: "ready", runtimeId: `fixture-${suffix}` });
    const asset = await repositories.assets.createPending(identityA, {
      projectId: project.id, contentType: "image/png", sizeBytes: 512, sha256: "a".repeat(64),
    });
    const version = await repositories.versions.create(identityA, { projectId: project.id, sha256: "b".repeat(64), sizeBytes: 1024 });
    await repositories.versions.setStatus(identityA, version.id, "ready");
    const publication = await repositories.publications.create(identityA, { projectId: project.id, versionId: version.id });

    const deletionRace = await Promise.allSettled([
      repositories.messages.create(identityA, {
        projectId: project.id, requestId: `racing-message-${suffix}`, role: "user", content: "Mensaje concurrente",
      }),
      repositories.projects.delete(identityA, project.id),
    ]);
    const result = deletionRace[1];
    expect(result?.status).toBe("fulfilled");
    const raceMessage = deletionRace[0];
    if (raceMessage?.status === "fulfilled") {
      expect(raceMessage.value.content).toBe("Mensaje concurrente");
    } else {
      expect(raceMessage?.reason).toBeInstanceOf(OwnedResourceNotFoundError);
    }
    if (result?.status === "fulfilled") expect(result.value.cleanup.status).toBe("queued");
    expect(await repositories.projects.get(identityA, project.id)).toBeUndefined();
    expect((await repositories.projects.list(identityA)).items.map((item) => item.id)).not.toContain(project.id);
    await expect(repositories.projects.rename(identityA, project.id, "Regreso")).rejects.toThrow("Recurso no encontrado");
    await expect(repositories.projects.delete(identityA, project.id)).rejects.toThrow("Recurso no encontrado");
    await expect(repositories.messages.list(identityA, project.id)).rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    await expect(repositories.messages.create(identityA, {
      projectId: project.id, requestId: `after-delete-${suffix}`, role: "user", content: "No se permite",
    })).rejects.toThrow("Recurso no encontrado");
    await expect(repositories.runs.create(identityA, { projectId: project.id, idempotencyKey: `after-delete-${suffix}` }))
      .rejects.toThrow("Recurso no encontrado");
    expect(await repositories.runs.get(identityA, run.id)).toBeUndefined();
    await expect(repositories.runs.setStatus(identityA, run.id, "succeeded")).rejects.toThrow("Recurso no encontrado");
    await expect(repositories.runs.appendEvent(identityA, run.id, { type: "run.started", payload: {} }))
      .rejects.toThrow("Recurso no encontrado");
    await expect(repositories.sandboxes.upsert(identityA, { projectId: project.id, status: "ready" }))
      .rejects.toThrow("Recurso no encontrado");
    await expect(repositories.assets.createPending(identityA, {
      projectId: project.id, contentType: "image/png", sizeBytes: 512, sha256: "c".repeat(64),
    })).rejects.toThrow("Recurso no encontrado");
    await expect(repositories.versions.setStatus(identityA, version.id, "ready"))
      .rejects.toThrow("Recurso no encontrado");
    await expect(repositories.publications.setStatus(identityA, publication.id, "published"))
      .rejects.toThrow("Recurso no encontrado");
    await expect(repositories.usage.reserve(identityA, {
      projectId: project.id, idempotencyKey: `deleted-reservation-${suffix}`, expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow("Recurso no encontrado");

    const [cleanupTask] = await database.db.select().from(projectCleanupTasks).where(eq(projectCleanupTasks.projectId, project.id));
    const [storedRun] = await database.db.select().from(runs).where(eq(runs.id, run.id));
    const [storedSandbox] = await database.db.select().from(sandboxes).where(eq(sandboxes.id, sandbox.id));
    const [storedAsset] = await database.db.select().from(assets).where(eq(assets.id, asset.id));
    const [storedVersion] = await database.db.select().from(versions).where(eq(versions.id, version.id));
    const [storedPublication] = await database.db.select().from(publications).where(eq(publications.id, publication.id));
    expect(cleanupTask).toMatchObject({ status: "queued", projectId: project.id });
    expect(storedRun).toMatchObject({ status: "cancelled", errorCode: "project_deleted" });
    expect(storedSandbox?.status).toBe("stopping");
    expect(storedAsset?.status).toBe("delete_requested");
    expect(storedVersion?.status).toBe("delete_requested");
    expect(storedPublication?.status).toBe("revoked");
    expect(await repositories.projects.get(identityB, project.id)).toBeUndefined();
    expect(await database.db.select().from(projectCleanupTasks).where(and(eq(projectCleanupTasks.projectId, project.id), eq(projectCleanupTasks.status, "queued")))).toHaveLength(1);
  });
});
