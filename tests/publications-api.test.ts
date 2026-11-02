import { afterEach, describe, expect, it, vi } from "vitest";
import { identityFromAuthenticatedSession } from "@meta-game/db";
import type { ProjectApiContext } from "../apps/web/server/projects/api";
import { createPublicationHandlers } from "../apps/web/server/projects/publication-handlers";

const projectId = "00000000-0000-4000-8000-000000000111";
const versionId = "00000000-0000-4000-8000-000000000211";
const publicationId = "00000000-0000-4000-8000-000000000311";
const identity = identityFromAuthenticatedSession({ userId: "user_publicationOwnerA001" });
const stored = {
  id: publicationId, projectId, versionId, versionNumber: 4, slug: "a1b2c3d4e5f607182930", status: "published",
  idempotencyKey: "publish-request-001", artifactSha256: "a".repeat(64), snapshotKey: "private-not-public",
  manifest: {}, createdAt: new Date("2026-11-02T12:00:00.000Z"),
};

function makeContext(options: { owned?: boolean; status?: string } = {}) {
  const publication = { ...stored, status: options.status ?? stored.status };
  const repositories = {
    projects: { get: vi.fn(async (_identity: unknown, id: string) => options.owned === false || id !== projectId ? undefined : { id }) },
    versions: { get: vi.fn(async (_identity: unknown, _projectId: string, id: string) => id === versionId ? { id, status: "ready" } : undefined) },
    publications: {
      list: vi.fn(async () => ({ items: [publication], nextCursor: null })),
      get: vi.fn(async (_identity: unknown, _projectId: string, id: string) => id === publicationId ? publication : undefined),
    },
  };
  return { identity, allowedOrigins: ["http://localhost:3000"], repositories } as unknown as ProjectApiContext;
}

const originalEnvironment = {
  PUBLISHING_ENABLED: process.env.PUBLISHING_ENABLED,
  PUBLISH_BASE_DOMAIN: process.env.PUBLISH_BASE_DOMAIN,
  WORKER_INTERNAL_URL: process.env.WORKER_INTERNAL_URL,
  WORKER_INTERNAL_TOKEN: process.env.WORKER_INTERNAL_TOKEN,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function enablePublishing() {
  process.env.PUBLISHING_ENABLED = "true";
  process.env.PUBLISH_BASE_DOMAIN = "games.example.test";
  process.env.WORKER_INTERNAL_URL = "http://worker:8082";
  process.env.WORKER_INTERNAL_TOKEN = "worker-fixture-token-".repeat(2);
}

describe("API de publicaciones", () => {
  it("lista historial propio con URL solo en ready y sin claves de storage", async () => {
    enablePublishing();
    const context = makeContext();
    const handlers = createPublicationHandlers(context);
    const response = await handlers.list(new Request("http://localhost/api"), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(200);
    const payload = await response.json() as { items: Array<Record<string, unknown>> };
    expect(payload.items[0]).toMatchObject({ status: "ready", versionNumber: 4, url: `https://${stored.slug}.games.example.test` });
    expect(JSON.stringify(payload)).not.toContain("private-not-public");
  });

  it("rechaza origen cruzado y no llama al worker para un proyecto ajeno", async () => {
    enablePublishing();
    const fetcher = vi.fn<typeof fetch>();
    const context = makeContext({ owned: false });
    const handlers = createPublicationHandlers(context, { fetcher });
    const request = new Request("http://localhost/api", {
      method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
      body: JSON.stringify({ versionId, idempotencyKey: "publish-request-001" }),
    });
    const response = await handlers.create(request, { params: Promise.resolve({ projectId }) });
    expect([403, 404]).toContain(response.status);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("envía al worker el owner de sesión, versión e idempotency key; nunca habilita source sharing", async () => {
    enablePublishing();
    const context = makeContext({ status: "building" });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ publication: { id: publicationId } }, { status: 202 }));
    const handlers = createPublicationHandlers(context, { fetcher });
    const response = await handlers.create(new Request("http://localhost/api", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ versionId, idempotencyKey: "publish-request-001" }),
    }), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(202);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`http://worker:8082/internal/projects/${projectId}/publications`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"worker-fixture-token-".repeat(2)}`);
    expect(JSON.parse(String(init?.body))).toEqual({ userId: identity.userId, versionId, idempotencyKey: "publish-request-001" });
    const body = await response.json() as { publication: Record<string, unknown> };
    expect(body.publication.status).toBe("pending");
    expect(body.publication).not.toHaveProperty("manifest");
  });

  it("revoca por worker autenticado y deja la invalidación del lado del origen", async () => {
    enablePublishing();
    const context = makeContext();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ publication: { id: publicationId } }));
    const handlers = createPublicationHandlers(context, { fetcher });
    const response = await handlers.revoke(new Request("http://localhost/api", {
      method: "DELETE", headers: { origin: "http://localhost:3000" },
    }), { params: Promise.resolve({ projectId, publicationId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true, id: publicationId });
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("mantiene la publicación apagada si el operador no la habilita", async () => {
    process.env.PUBLISHING_ENABLED = "false";
    const handlers = createPublicationHandlers(makeContext());
    const response = await handlers.list(new Request("http://localhost/api"), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(503);
  });
});
