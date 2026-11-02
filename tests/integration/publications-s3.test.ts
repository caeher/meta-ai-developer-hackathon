import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalPublicationManifest, PublicationFileSchema, type PublicationManifest } from "@meta-game/contracts";
import { createPublicationArtifactStorageFromEnvironment } from "@meta-game/storage";
import { createPublishingOriginServer, requestPath, requestSlug } from "../../apps/publishing-origin/src/server";

const integrationEnabled = process.env.PUBLICATION_S3_TEST_ENABLED === "1";

describe.skipIf(!integrationEnabled)("publicación estática con Silo local y origen HTTP", () => {
  const slug = randomUUID().replaceAll("-", "").slice(0, 20);
  let writer: ReturnType<typeof createPublicationArtifactStorageFromEnvironment>;
  let reader: ReturnType<typeof createPublicationArtifactStorageFromEnvironment>;
  let server: ReturnType<typeof createPublishingOriginServer>;
  let origin: string;
  let status: "published" | "revoked" = "published";
  let artifactSha256: string | null = null;
  let manifest: PublicationManifest | undefined;
  let lastLookupSlug: string | undefined;
  let lastReadPath: string | undefined;

  beforeAll(async () => {
    writer = createPublicationArtifactStorageFromEnvironment(process.env, "worker");
    reader = createPublicationArtifactStorageFromEnvironment(process.env, "reader");
    server = createPublishingOriginServer({
      baseDomain: "games.example.test",
      publications: {
        async getBySlug(requestedSlug) {
          lastLookupSlug = requestedSlug;
          if (requestedSlug !== slug || !manifest || !artifactSha256) return undefined;
          return { slug, artifactKey: `published/${slug}`, artifactSha256, manifest, status };
        },
      },
      artifacts: { read: async (requestedSlug, file) => {
        lastReadPath = file.path;
        return reader.read(requestedSlug, PublicationFileSchema.parse(file));
      } },
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("origin_test_address_unavailable");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    try { await writer?.delete(slug); } catch { /* The bucket is temporary and cleaned by the integration harness. */ }
    writer?.close();
    reader?.close();
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("sirve solo el manifiesto anónimamente y deja de servir al revocar y borrar", async () => {
    const html = Buffer.from("<!doctype html><html><script type=module src='/assets/game.js'></script></html>");
    const javascript = Buffer.from("globalThis.gameReady = true;");
    const published = await writer.write(slug, [
      { path: "index.html", contentType: "text/html; charset=utf-8", body: html },
      { path: "assets/game.js", contentType: "text/javascript; charset=utf-8", body: javascript },
    ]);
    manifest = published.manifest;
    artifactSha256 = published.artifactSha256;
    expect(await reader.read(slug, published.manifest.files.find(({ path }) => path === "assets/game.js")!)).toEqual(javascript);

    const host = `${slug}.games.example.test`;
    expect(requestSlug(host, "games.example.test")).toBe(slug);
    expect(requestPath("/")).toBe("index.html");
    expect(createHash("sha256").update(canonicalPublicationManifest(manifest!)).digest("hex")).toBe(artifactSha256);
    const page = await requestPublication("/", "GET", host);
    expect(lastLookupSlug).toBe(slug);
    expect(lastReadPath).toBe("index.html");
    expect({ status: page.status, body: page.body }).toEqual({ status: 200, body: html.toString("utf8") });
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["permissions-policy"]).toContain("camera=()");
    expect(page.headers["cache-control"]).toContain("max-age=60");

    const head = await requestPublication("/assets/game.js", "HEAD", host);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(javascript.byteLength));
    expect(head.body).toBe("");

    for (const path of ["/.env", "/src/main.ts", "/assets/game.js.map"]) {
      expect((await requestPublication(path, "GET", host)).status).toBe(404);
    }

    status = "revoked";
    expect((await requestPublication("/", "GET", host)).status).toBe(404);
    await writer.delete(slug);
    await expect(reader.read(slug, published.manifest.files[0]!)).rejects.toThrow();
  });

  function requestPublication(path: string, method: "GET" | "HEAD", host: string): Promise<{
    status: number; headers: IncomingHttpHeaders; body: string;
  }> {
    const port = new URL(origin).port;
    return new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: { host } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.once("error", reject);
      request.end();
    });
  }
});
