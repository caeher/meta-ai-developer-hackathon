import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { identityFromAuthenticatedSession } from "@meta-game/db";
import { createPublicationPipeline, contentTypeForPath, hasSecretContent } from "../apps/worker/src/pipelines/publish-game";

const identity = identityFromAuthenticatedSession({ userId: "user_publishPipelineA001" });
const projectId = "00000000-0000-4000-8000-000000000111";
const versionId = "00000000-0000-4000-8000-000000000211";
const publicationId = "00000000-0000-4000-8000-000000000311";
const buildProjectId = "00000000-0000-4000-8000-000000000411";
const slug = "a1b2c3d4e5f607182930";

function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

describe("pipeline de publicación", () => {
  it("reconstruye un snapshot verificado en un sandbox temporal y sube solo dist", async () => {
    const publication = {
      id: publicationId, projectId, versionId, slug, artifactKey: `published/${slug}`,
      status: "building", buildLeaseToken: null, idempotencyKey: "publish-request-001",
    };
    const html = "<!doctype html><html><script type=module src='./game.js'></script></html>";
    const javascript = "globalThis.gameReady = true;";
    const commands: string[][] = [];
    const sandbox = {
      create: vi.fn(async (id: string) => {
        expect(id).toBe(buildProjectId);
        return { sandboxId: "fixture", state: "ready", leaseExpiresAt: null, devServer: { status: "stopped", port: null, leaseExpiresAt: null } };
      }),
      destroy: vi.fn(async () => ({ sandboxId: "fixture", state: "stopped", leaseExpiresAt: null, devServer: { status: "stopped", port: null, leaseExpiresAt: null } })),
      writeFile: vi.fn(async (_id: string, path: string, content: string) => ({ path, bytesWritten: Buffer.byteLength(content) })),
      writeBinaryFile: vi.fn(async (_id: string, path: string, body: Uint8Array) => ({ path, bytesWritten: body.byteLength })),
      runCommand: vi.fn(async (_id: string, request: { args: string[] }) => { commands.push(request.args); return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, truncated: false }; }),
      listFiles: vi.fn(async (_id: string, path: string) => path === "dist"
        ? { path, files: [{ name: "index.html", type: "file" as const, size: html.length }, { name: "game.js", type: "file" as const, size: javascript.length }] }
        : { path, files: [] }),
      readFile: vi.fn(async (_id: string, path: string) => ({ path, content: path === "dist/index.html" ? html : javascript })),
      readBinaryFile: vi.fn(async () => Buffer.alloc(0)),
    };
    const repositories = {
      projects: {
        createBuildWorkspace: vi.fn(async () => ({ id: buildProjectId })),
        deleteBuildWorkspace: vi.fn(async () => ({ id: buildProjectId })),
        reapBuildWorkspaces: vi.fn(async () => ({ deleted: 0 })),
      },
      publications: {
        create: vi.fn(async () => publication),
        claimBuild: vi.fn(async () => ({ ...publication, status: "building", buildLeaseToken: "00000000-0000-4000-8000-000000000511" })),
        renewBuildLease: vi.fn(async () => publication),
        getForCleanup: vi.fn(async () => ({ ...publication, status: "building", buildLeaseToken: "00000000-0000-4000-8000-000000000511" })),
        markPublished: vi.fn(async () => ({ ...publication, status: "published", artifactSha256: "a".repeat(64) })),
        markBuildFailed: vi.fn(async () => ({ ...publication, status: "failed" })),
        setStatus: vi.fn(async () => ({ ...publication, status: "revoked" })),
        listExpiredBuilds: vi.fn(async () => []),
      },
    };
    const manifest = {
      schemaVersion: 1 as const,
      files: [
        { path: "index.html", contentType: "text/html; charset=utf-8" as const, bytes: Buffer.byteLength(html), sha256: digest(Buffer.from(html)), key: `published/${slug}/index.html` },
        { path: "game.js", contentType: "text/javascript; charset=utf-8" as const, bytes: Buffer.byteLength(javascript), sha256: digest(Buffer.from(javascript)), key: `published/${slug}/game.js` },
      ],
      totalBytes: Buffer.byteLength(html) + Buffer.byteLength(javascript),
      indexSha256: digest(Buffer.from(html)),
    };
    const artifacts = {
      write: vi.fn(async (artifactSlug: string) => {
        if (artifactSlug !== slug) throw new Error("unexpected_publication_slug");
        return { manifest, artifactSha256: "a".repeat(64) };
      }),
      delete: vi.fn(async () => undefined),
      close: vi.fn(),
      read: vi.fn(),
    };
    const versions = {
      read: vi.fn(async () => ({
        version: { id: versionId, status: "ready", manifest: { verification: { status: "passed" } } },
        snapshot: {
          verification: { status: "passed", checks: [{ status: "passed" }] },
          files: [
            { path: "package.json", encoding: "utf8" as const, content: "{}", bytes: 2 },
            { path: "package-lock.json", encoding: "utf8" as const, content: "{}", bytes: 2 },
            { path: "src/game.ts", encoding: "utf8" as const, content: "export {};", bytes: 10 },
          ],
        },
      })),
    };
    const pipeline = createPublicationPipeline({
      repositories: repositories as never,
      versions,
      sandbox: sandbox as never,
      artifacts: artifacts as never,
    });

    const accepted = await pipeline.start(identity, projectId, versionId, "publish-request-001");
    expect(accepted.status).toBe("building");
    await vi.waitFor(() => expect(repositories.publications.markPublished).toHaveBeenCalledOnce());
    expect(repositories.projects.createBuildWorkspace).toHaveBeenCalledOnce();
    expect(sandbox.create).toHaveBeenCalledWith(buildProjectId);
    expect(sandbox.writeFile).toHaveBeenCalledWith(buildProjectId, "src/game.ts", "export {};");
    expect(commands).toEqual([
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=http://npm-proxy:8080/registry/registry.npmjs.org/"],
      ["run", "build"],
    ]);
    expect(artifacts.write).toHaveBeenCalledOnce();
    expect(artifacts.write.mock.calls[0]?.[0]).toBe(slug);
    expect(repositories.projects.deleteBuildWorkspace).toHaveBeenCalledWith(identity, buildProjectId);
    expect(sandbox.destroy).toHaveBeenCalledWith(buildProjectId);
  });

  it("bloquea mapas, rutas ocultas y credenciales con firmas construidas en tiempo de ejecución", () => {
    expect(() => contentTypeForPath("../index.html")).toThrow();
    expect(() => contentTypeForPath("assets/game.js.map")).toThrow();
    expect(() => contentTypeForPath(".env" )).toThrow();
    const awsMarker = `${["AK", "IA"].join("")}${"A".repeat(16)}`;
    expect(hasSecretContent(Buffer.from(`window.config = '${awsMarker}'`))).toBe(true);
    expect(hasSecretContent(Buffer.from("A public game build without credentials"))).toBe(false);
  });
});
