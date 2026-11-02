import { describe, expect, it, vi } from "vitest";
import { identityFromAuthenticatedSession } from "@meta-game/db";
import type { ProjectApiContext } from "../apps/web/server/projects/api";
import { createVersionHandlers } from "../apps/web/server/projects/version-handlers";

const projectId = "00000000-0000-4000-8000-000000000111";
const versionId = "00000000-0000-4000-8000-000000000211";
const identity = identityFromAuthenticatedSession({ userId: "user_versionRouteOwner001" });
const storedVersion = {
  id: versionId, projectId, versionNumber: 3, runId: "00000000-0000-4000-8000-000000000311",
  parentVersionId: null, snapshotKey: "private/secret/object-key", sha256: "a".repeat(64), sizeBytes: 512,
  status: "ready", createdAt: new Date("2026-11-02T12:00:00.000Z"),
  manifest: { changes: { added: ["src/main.ts"], modified: [], removed: [] } },
};

function makeContext(options: { version?: typeof storedVersion } = {}) {
  const repositories = {
    projects: { get: vi.fn(async (_identity: unknown, id: string) => id === projectId ? { id } : undefined) },
    versions: {
      list: vi.fn(async () => ({ items: options.version ? [options.version] : [], nextCursor: null })),
      get: vi.fn(async (_identity: unknown, _projectId: string, id: string) => id === options.version?.id ? options.version : undefined),
    },
  };
  return { identity, allowedOrigins: ["http://localhost:3000"], repositories } as unknown as ProjectApiContext;
}

describe("API privada de versiones", () => {
  it("lista solo versiones ready del proyecto y oculta claves de S3", async () => {
    const handlers = createVersionHandlers(makeContext({ version: storedVersion }), {});
    const response = await handlers.list(new Request(`http://localhost/api/projects/${projectId}/versions`), { params: Promise.resolve({ projectId }) });
    expect(response.status).toBe(200);
    const payload = await response.json() as { latestVersionId: string; items: Array<Record<string, unknown>> };
    expect(payload.latestVersionId).toBe(versionId);
    expect(JSON.stringify(payload)).not.toContain("private/secret/object-key");
  });

  it("devuelve 404 uniforme si otra identidad consulta una versión ajena", async () => {
    const context = makeContext();
    const handlers = createVersionHandlers(context, {});
    const response = await handlers.get(new Request("http://localhost"), { params: Promise.resolve({ projectId, versionId }) });
    expect(response.status).toBe(404);
  });

  it("envía al worker únicamente la identidad autenticada y bloquea restore desde otro origen", async () => {
    const context = makeContext({ version: storedVersion });
    const fetcher = vi.fn<typeof fetch>(async (...args: Parameters<typeof fetch>) => {
      void args;
      return Response.json({ restored: { versionId: "00000000-0000-4000-8000-000000000411", versionNumber: 4 } });
    });
    const handlers = createVersionHandlers(context, { workerUrl: "http://worker:8082", workerToken: "t".repeat(40), fetcher: fetcher as typeof fetch });
    const crossOrigin = await handlers.restore(new Request("http://localhost/api", { method: "POST", headers: { origin: "https://attacker.invalid" } }), { params: Promise.resolve({ projectId, versionId }) });
    expect(crossOrigin.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();

    const response = await handlers.restore(new Request("http://localhost/api", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ projectId, versionId }) });
    expect(response.status).toBe(200);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`http://worker:8082/internal/projects/${projectId}/versions/${versionId}/restore`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${"t".repeat(40)}`);
    expect(JSON.parse(String(init?.body))).toEqual({ clerkUserId: identity.clerkUserId });
  });
});
