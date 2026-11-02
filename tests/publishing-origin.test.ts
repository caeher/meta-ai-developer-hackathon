import { createHash } from "node:crypto";
import { canonicalPublicationManifest } from "@meta-game/contracts";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationArtifactKey, type PublicationManifest } from "@meta-game/contracts";
import { createPublishingOriginServer, requestPath, requestSlug } from "../apps/publishing-origin/src/server";

const slug = "a1b2c3d4e5f607182930";
let activeServer: ReturnType<typeof createPublishingOriginServer> | undefined;
let activePort: number | undefined;

function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

async function startOrigin(status = "published") {
  const html = Buffer.from("<!doctype html><html><body>Published fixture</body></html>");
  const js = Buffer.from("globalThis.ready = true;");
  const manifest: PublicationManifest = {
    schemaVersion: 1,
    files: [
      { path: "index.html", contentType: "text/html; charset=utf-8", bytes: html.byteLength, sha256: digest(html), key: publicationArtifactKey(slug, "index.html") },
      { path: "assets/game.js", contentType: "text/javascript; charset=utf-8", bytes: js.byteLength, sha256: digest(js), key: publicationArtifactKey(slug, "assets/game.js") },
    ],
    totalBytes: html.byteLength + js.byteLength,
    indexSha256: digest(html),
  };
  const files = new Map([["index.html", html], ["assets/game.js", js]]);
  let currentStatus = status;
  const getBySlug = vi.fn(async (requestedSlug: string) => requestedSlug === slug ? ({
    slug, artifactKey: `published/${slug}`, artifactSha256: digest(Buffer.from(canonicalPublicationManifest(manifest))), manifest, status: currentStatus,
  }) : undefined);
  const read = vi.fn(async (requestedSlug: string, file: { path: string }) => {
    if (requestedSlug !== slug || !files.has(file.path)) throw new Error("missing");
    return files.get(file.path)!;
  });
  activeServer = createPublishingOriginServer({ baseDomain: "games.example.test", publications: { getBySlug }, artifacts: { read } });
  await new Promise<void>((resolve) => activeServer!.listen(0, "127.0.0.1", resolve));
  const address = activeServer.address();
  if (!address || typeof address === "string") throw new Error("listener failed");
  activePort = address.port;
  return { getBySlug, read, manifest, setStatus(value: string) { currentStatus = value; } };
}

async function originRequest(path: string, host: string, method = "GET") {
  return new Promise<{ status: number; headers: Headers; text: string }>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: activePort, path, method, headers: { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve({ status: response.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

afterEach(async () => {
  if (activeServer?.listening) await new Promise<void>((resolve, reject) => activeServer!.close((error) => error ? reject(error) : resolve()));
  activeServer = undefined;
  activePort = undefined;
});

describe("origen público de publicaciones", () => {
  it("sirve solo archivos publicados por host, con CSP y caché acotada", async () => {
    const { getBySlug, read } = await startOrigin();
    const response = await originRequest("/", `${slug}.games.example.test`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toContain("max-age=60");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.text).toContain("Published fixture");

    const asset = await originRequest("/assets/game.js", `${slug}.games.example.test`);
    expect(asset.status).toBe(200);
    expect(asset.text).toContain("globalThis.ready");
    expect(getBySlug).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bloquea host ajeno, traversal, métodos de escritura y revocación inmediata", async () => {
    await startOrigin();
    const wrongHost = await originRequest("/", "other.example.test");
    expect(wrongHost.status).toBe(404);
    const traversal = await originRequest("/%2e%2e/private", `${slug}.games.example.test`);
    expect(traversal.status).toBe(404);
    const write = await originRequest("/", `${slug}.games.example.test`, "POST");
    expect(write.status).toBe(405);

    await new Promise<void>((resolve, reject) => activeServer!.close((error) => error ? reject(error) : resolve()));
    activeServer = undefined;
    const revoked = await startOrigin("revoked");
    const response = await originRequest("/", `${slug}.games.example.test`);
    expect(response.status).toBe(404);
    expect(revoked.read).not.toHaveBeenCalled();
  });

  it("rechaza segmentos host y rutas ambiguas", () => {
    expect(requestSlug(`${slug}.games.example.test`, "games.example.test")).toBe(slug);
    expect(requestSlug(`bad.${slug}.games.example.test`, "games.example.test")).toBeUndefined();
    expect(requestPath("/%2fetc/passwd")).toBeUndefined();
    expect(requestPath("/a/%2e%2e/b.js")).toBeUndefined();
  });
});
