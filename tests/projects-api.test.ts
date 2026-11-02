import { beforeEach, describe, expect, it } from "vitest";
import { identityFromAuthenticatedSession, IdempotencyConflictError, OwnedResourceNotFoundError, type VerifiedIdentityContext } from "@meta-game/db";
import { createProjectCollectionHandlers } from "../apps/web/server/projects/collection-handlers";
import { createProjectHandlers } from "../apps/web/server/projects/handlers";
import { createProjectMessageHandlers } from "../apps/web/server/projects/message-handlers";

const ownerA = identityFromAuthenticatedSession({ userId: "user_projectsA" });
const ownerB = identityFromAuthenticatedSession({ userId: "user_projectsB" });
const projectId = "11111111-1111-4111-8111-111111111111";
const timestamp = new Date("2026-01-01T00:00:00.000Z");

function projectFixture(identity: VerifiedIdentityContext, name = "Aventura") {
  return { id: projectId, ownerUserId: "opaque-owner", name, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, owner: identity.clerkUserId };
}

describe("API de proyectos y mensajes", () => {
  let project = projectFixture(ownerA);
  const allowedOrigins = ["http://localhost:3000"];

  beforeEach(() => {
    project = projectFixture(ownerA);
  });

  it("lista páginas privadas y crea proyectos con nombre validado", async () => {
    const calls: unknown[] = [];
    const projects = {
      async list(identity: VerifiedIdentityContext, input: unknown) {
        calls.push({ identity: identity.clerkUserId, input });
        return { items: [project], nextCursor: null };
      },
      async create(identity: VerifiedIdentityContext, input: { name: string }) {
        calls.push({ identity: identity.clerkUserId, input });
        return { ...project, name: input.name };
      },
    };
    const handlers = createProjectCollectionHandlers({ identity: ownerA, projects: projects as never, allowedOrigins });
    const list = await handlers.GET(new Request("http://localhost:3000/api/projects?limit=1"));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ id: projectId, name: "Aventura" }], nextCursor: null });
    expect(list.headers.get("cache-control")).toBe("private, no-store");

    const create = await handlers.POST(new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ name: "  Mi juego  ", ownerUserId: "forged" }),
    }));
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ name: "Mi juego" });
    expect(calls).toContainEqual({ identity: "user_projectsA", input: { name: "Mi juego" } });
  });

  it("oculta proyectos ajenos y exige origen propio para borrar", async () => {
    const projects = {
      async get(identity: VerifiedIdentityContext, id: string) {
        return identity.clerkUserId === project.owner && id === project.id ? project : undefined;
      },
      async rename(identity: VerifiedIdentityContext, id: string) {
        if (identity.clerkUserId !== project.owner || id !== project.id) throw new OwnedResourceNotFoundError();
        return project;
      },
      async delete(identity: VerifiedIdentityContext, id: string) {
        if (identity.clerkUserId !== project.owner || id !== project.id) throw new OwnedResourceNotFoundError();
        return { id, deletedAt: timestamp, cleanup: { id: projectId, status: "queued" } };
      },
    };
    const handlers = createProjectHandlers({
      authenticator: { requireUser: async () => ownerB },
      projects: projects as never,
      allowedOrigins,
    });
    const context = { params: Promise.resolve({ projectId }) };
    const crossOwner = await handlers.GET(new Request("http://localhost:3000/api/projects"), context);
    expect(crossOwner.status).toBe(404);
    const absent = await createProjectHandlers({
      authenticator: { requireUser: async () => ownerA },
      projects: projects as never,
      allowedOrigins,
    }).GET(new Request("http://localhost:3000/api/projects"), {
      params: Promise.resolve({ projectId: "33333333-3333-4333-8333-333333333333" }),
    });
    expect(await crossOwner.json()).toEqual(await absent.json());
    expect(absent.status).toBe(404);

    const deniedDelete = await handlers.DELETE(new Request("http://localhost:3000/api/projects", {
      method: "DELETE",
      headers: { origin: "http://localhost:3000" },
    }), context);
    expect(deniedDelete.status).toBe(404);
    const blocked = await handlers.DELETE(new Request("http://localhost:3000/api/projects", {
      method: "DELETE",
      headers: { origin: "https://attacker.example" },
    }), context);
    expect(blocked.status).toBe(403);
  });

  it("persiste texto plano con identidad autenticada y devuelve 404 en acceso cruzado", async () => {
    let stored: Record<string, unknown> | undefined;
    const messages = {
      async create(identity: VerifiedIdentityContext, input: Record<string, unknown>) {
        if (stored && stored.requestId === input.requestId) {
          if (stored.content !== input.content) throw new IdempotencyConflictError();
          return stored;
        }
        stored = { ...input, id: "22222222-2222-4222-8222-222222222222", owner: identity.clerkUserId, sequence: 1, createdAt: timestamp };
        return stored;
      },
      async list() { return { items: [], nextCursor: null }; },
    };
    const projects = {
      async get(identity: VerifiedIdentityContext) { return identity.clerkUserId === project.owner ? project : undefined; },
    };
    const handlers = createProjectMessageHandlers({ identity: ownerA, messages: messages as never, projects: projects as never, allowedOrigins });
    const context = { params: Promise.resolve({ projectId }) };
    const response = await handlers.POST(new Request("http://localhost:3000/api/projects/messages", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request-0001", content: "<script>alert(1)</script>" }),
    }), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ role: "user", content: "<script>alert(1)</script>", requestId: "request-0001" });
    expect(stored).toMatchObject({ owner: "user_projectsA", projectId, role: "user" });

    const conflict = await handlers.POST(new Request("http://localhost:3000/api/projects/messages", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request-0001", content: "Changed body" }),
    }), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "idempotency_conflict" });

    const crossOwner = createProjectMessageHandlers({ identity: ownerB, messages: messages as never, projects: projects as never, allowedOrigins });
    const denied = await crossOwner.GET(new Request("http://localhost:3000/api/projects/messages"), context);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "not_found" });
  });
});
