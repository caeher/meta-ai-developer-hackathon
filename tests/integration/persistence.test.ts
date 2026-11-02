import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseFromEnvironment,
  createRepositories,
  createOrGetProjectSandbox,
  getProjectSandbox,
  identityFromAuthenticatedSession,
  IdempotencyConflictError,
  assets,
  messages,
  users,
  type VerifiedIdentityContext,
} from "@meta-game/db";
import { createPrivateStorageFromEnvironment } from "@meta-game/storage";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";

describe.skipIf(!integrationEnabled)("persistencia PostgreSQL y storage S3", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const clerkUserIdA = `user_integrationA${suffix}`;
  const clerkUserIdB = `user_integrationB${suffix}`;
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  let repositories: ReturnType<typeof createRepositories>;
  let identityA: ReturnType<typeof identityFromAuthenticatedSession>;
  let identityB: ReturnType<typeof identityFromAuthenticatedSession>;
  let projectA: Awaited<ReturnType<ReturnType<typeof createRepositories>["projects"]["create"]>>;
  let projectASecond: typeof projectA;
  let projectB: typeof projectA;
  let storage: ReturnType<typeof createPrivateStorageFromEnvironment>;
  let uploadedAssetId: string | undefined;

  beforeAll(async () => {
    database = createDatabaseFromEnvironment();
    repositories = createRepositories(database.db);
    identityA = identityFromAuthenticatedSession({ userId: clerkUserIdA });
    identityB = identityFromAuthenticatedSession({ userId: clerkUserIdB });
    projectA = await repositories.projects.create(identityA, { name: "Integration owner A" });
    projectASecond = await repositories.projects.create(identityA, { name: "Integration owner A second" });
    projectB = await repositories.projects.create(identityB, { name: "Integration owner B" });
    storage = createPrivateStorageFromEnvironment(repositories.assets);
  });

  afterAll(async () => {
    if (uploadedAssetId && storage && identityA) {
      try {
        await storage.delete(identityA, uploadedAssetId);
      } catch {
        // The test bucket uses unique object keys; database cleanup below remains scoped to these fixtures.
      }
    }
    if (database) {
      await database.db.delete(users).where(inArray(users.clerkUserId, [clerkUserIdA, clerkUserIdB]));
      storage?.close();
      await database.close();
    }
  });

  it("registra un sandbox por proyecto con owner y UID aislados", async () => {
    const [sandboxA, sandboxA2, sandboxB] = await Promise.all([
      createOrGetProjectSandbox(database.db, projectA.id),
      createOrGetProjectSandbox(database.db, projectASecond.id),
      createOrGetProjectSandbox(database.db, projectB.id),
    ]);
    expect(sandboxA.ownerUserId).toBe(sandboxA2.ownerUserId);
    expect(sandboxA.ownerUserId).not.toBe(sandboxB.ownerUserId);
    expect(new Set([sandboxA.runtimeUid, sandboxA2.runtimeUid, sandboxB.runtimeUid]).size).toBe(3);
    expect(await createOrGetProjectSandbox(database.db, projectA.id)).toMatchObject({
      id: sandboxA.id,
      ownerUserId: sandboxA.ownerUserId,
      runtimeUid: sandboxA.runtimeUid,
    });
    expect(await getProjectSandbox(database.db, projectB.id)).toMatchObject({
      id: sandboxB.id,
      projectId: projectB.id,
      ownerUserId: sandboxB.ownerUserId,
    });
  });

  it("aplica ownership uniforme y rechaza relaciones con dueño inconsistente", async () => {
    const forgedIdentity = { clerkUserId: clerkUserIdA } as unknown as VerifiedIdentityContext;
    await expect(repositories.projects.get(forgedIdentity, projectA.id)).rejects.toThrow(
      "identidad de servidor verificada",
    );
    expect(await repositories.projects.get(identityB, projectA.id)).toBeUndefined();
    await expect(
      repositories.messages.create(identityB, {
        projectId: projectA.id,
        requestId: `cross-owner-${suffix}`,
        role: "user",
        content: "cross-owner write",
      }),
    ).rejects.toThrow("Recurso no encontrado");

    const run = await repositories.runs.create(identityA, {
      projectId: projectA.id,
      idempotencyKey: `inconsistent-${suffix}`,
    });
    await expect(
      repositories.messages.create(identityA, {
        projectId: projectASecond.id,
        requestId: `wrong-run-project-${suffix}`,
        runId: run.id,
        role: "assistant",
        content: "run belongs to another project",
      }),
    ).rejects.toThrow("Recurso no encontrado");

    const [ownerA] = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkUserId, clerkUserIdA))
      .limit(1);
    expect(ownerA).toBeDefined();
    await expect(
      database.db.insert(messages).values({
        ownerUserId: ownerA!.id,
        projectId: projectB.id,
        role: "user",
        content: "direct SQL cannot cross composite ownership",
        requestId: `direct-sql-${suffix}`,
        sequence: 1,
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("pagina proyectos por owner sin solapamientos ni mezcla entre cuentas", async () => {
    await repositories.projects.create(identityA, { name: "Integration pagination 3" });
    await repositories.projects.create(identityA, { name: "Integration pagination 4" });
    const first = await repositories.projects.list(identityA, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await repositories.projects.list(identityA, { limit: 2, cursor: first.nextCursor! });
    const listedIds = [...first.items, ...second.items].map((project) => project.id);
    expect(new Set(listedIds).size).toBe(listedIds.length);
    expect(second.items.every((project) => project.ownerUserId === first.items[0]?.ownerUserId)).toBe(true);
    expect(listedIds).not.toContain(projectB.id);
  });

  it("hace runs idempotentes y serializa la secuencia durable de eventos", async () => {
    const key = `run-idempotency-${suffix}`;
    const first = await repositories.runs.create(identityA, { projectId: projectA.id, idempotencyKey: key });
    const repeated = await repositories.runs.create(identityA, { projectId: projectA.id, idempotencyKey: key });
    expect(repeated.id).toBe(first.id);
    await expect(
      repositories.runs.create(identityA, { projectId: projectASecond.id, idempotencyKey: key }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const events = await Promise.all([
      repositories.runs.appendEvent(identityA, first.id, {
        type: "plan.saved",
        payload: { fixture: true, step: 1 },
      }),
      repositories.runs.appendEvent(identityA, first.id, {
        type: "run.started",
        payload: { fixture: true, step: 2 },
      }),
    ]);
    expect(events.map((event) => event.sequence).sort()).toEqual([1, 2]);
    expect((await repositories.runs.listEvents(identityA, first.id, { afterSequence: 1 })).map((event) => event.sequence)).toEqual([2]);
  });

  it("valida la consistencia de versiones, publicaciones, cuotas y sandbox", async () => {
    const digest = "a".repeat(64);
    const version = await repositories.versions.create(identityA, {
      projectId: projectA.id,
      sha256: digest,
      sizeBytes: 256,
    });
    await expect(
      repositories.publications.create(identityA, { projectId: projectA.id, versionId: version.id }),
    ).rejects.toThrow("Recurso no encontrado");
    const readyVersion = await repositories.versions.setStatus(identityA, version.id, "ready");
    const publication = await repositories.publications.create(identityA, {
      projectId: projectA.id,
      versionId: readyVersion.id,
    });
    expect(publication.status).toBe("building");
    await expect(
      repositories.publications.create(identityB, { projectId: projectA.id, versionId: version.id }),
    ).rejects.toThrow("Recurso no encontrado");

    const reservationKey = `reservation-${suffix}`;
    const reservation = await repositories.usage.reserve(identityA, {
      projectId: projectA.id,
      idempotencyKey: reservationKey,
      reservedTokens: 100,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const repeated = await repositories.usage.reserve(identityA, {
      projectId: projectA.id,
      idempotencyKey: reservationKey,
      reservedTokens: 100,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(repeated.id).toBe(reservation.id);
    const ledger = await repositories.usage.record(identityA, {
      reservationId: reservation.id,
      idempotencyKey: `ledger-${suffix}`,
      kind: "charge",
      tokens: 42,
      metadata: { fixture: true },
    });
    expect(ledger.tokens).toBe(42);
    await repositories.usage.record(identityA, {
      reservationId: reservation.id,
      idempotencyKey: `ledger-second-${suffix}`,
      kind: "charge",
      tokens: 1,
      metadata: { fixture: true },
    });
    const firstLedgerPage = await repositories.usage.listLedger(identityA, projectA.id, { limit: 1 });
    expect(firstLedgerPage.items).toHaveLength(1);
    expect(firstLedgerPage.nextCursor).not.toBeNull();
    const secondLedgerPage = await repositories.usage.listLedger(identityA, projectA.id, {
      limit: 1,
      cursor: firstLedgerPage.nextCursor!,
    });
    expect(secondLedgerPage.items).toHaveLength(1);
    expect(secondLedgerPage.items[0]?.id).not.toBe(firstLedgerPage.items[0]?.id);

    const sandbox = await repositories.sandboxes.upsert(identityA, {
      projectId: projectA.id,
      status: "stopped",
    });
    const sandboxAgain = await repositories.sandboxes.upsert(identityA, {
      projectId: projectA.id,
      status: "ready",
      runtimeId: `fixture-${suffix}`,
    });
    expect(sandboxAgain.id).toBe(sandbox.id);
    expect(sandboxAgain.status).toBe("ready");
  });

  it("guarda objetos privados con checksum, niega lectura anónima y aplica owner al leer", async () => {
    const body = Buffer.from(`synthetic private fixture ${suffix}`);
    const asset = await storage.upload(identityA, {
      projectId: projectA.id,
      contentType: "application/octet-stream",
      body,
    });
    uploadedAssetId = asset.id;
    const [stored] = await database.db
      .select({ objectKey: assets.objectKey })
      .from(assets)
      .where(and(eq(assets.ownerUserId, projectA.ownerUserId), eq(assets.id, asset.id)))
      .limit(1);
    expect(stored).toBeDefined();
    const anonymousResponse = await fetch(
      new URL(`/${process.env.S3_BUCKET_PRIVATE}/${stored!.objectKey}`, process.env.S3_ENDPOINT),
    );
    expect(anonymousResponse.status).toBe(403);
    await expect(storage.read(identityB, asset.id)).rejects.toThrow("Recurso no encontrado");
    expect(Buffer.from((await storage.read(identityA, asset.id)).body)).toEqual(body);
    await storage.delete(identityA, asset.id);
    uploadedAssetId = undefined;
  });
});
