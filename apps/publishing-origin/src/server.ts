import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { canonicalPublicationManifest, PublicationManifestSchema, publicationArtifactKey } from "@meta-game/contracts";
import type { TelemetryMetrics } from "@meta-game/config";

const MAX_REQUEST_TARGET = 2_048;

export function createPublishingOriginServer(input: {
  baseDomain: string;
  publications: { getBySlug(slug: string): Promise<{
    slug: string; artifactKey: string; artifactSha256: string | null; manifest: Record<string, unknown>; status: string;
  } | undefined> };
  artifacts: { read(slug: string, file: { path: string; contentType: string; bytes: number; sha256: string; key: string }): Promise<Uint8Array> };
  metrics?: TelemetryMetrics;
}): Server {
  const domain = normalizeBaseDomain(input.baseDomain);
  const server = createServer((request, response) => {
    const started = Date.now();
    response.once("finish", () => {
      const method = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).has(request.method ?? "") ? request.method! : "OTHER";
      const statusClass = String(Math.floor(response.statusCode / 100)) + "xx";
      input.metrics?.increment("http_requests_total", { method, status_class: statusClass });
      input.metrics?.observe("http_request_duration_seconds", Math.max(0, Date.now() - started) / 1_000, { method });
    });
    void handle(request, response, domain, input);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  baseDomain: string,
  input: Parameters<typeof createPublishingOriginServer>[0],
) {
  setSecurityHeaders(response);
  if (request.method !== "GET" && request.method !== "HEAD") { sendError(response, 405, "method_not_allowed"); return; }
  if (!request.url || request.url.length > MAX_REQUEST_TARGET || request.headers.authorization || request.headers.cookie) {
    sendError(response, 400, "invalid_request"); return;
  }
  const slug = requestSlug(request.headers.host, baseDomain);
  const path = requestPath(request.url);
  if (!slug || !path) { sendError(response, 404, "not_found"); return; }
  try {
    const publication = await input.publications.getBySlug(slug);
    if (!publication || publication.status !== "published" || publication.slug !== slug ||
      publication.artifactKey !== `published/${slug}` || !publication.artifactSha256) {
      sendError(response, 404, "not_found"); return;
    }
    const manifest = PublicationManifestSchema.safeParse(publication.manifest);
    if (!manifest.success || digest(Buffer.from(canonicalPublicationManifest(manifest.data), "utf8")) !== publication.artifactSha256) {
      sendError(response, 404, "not_found"); return;
    }
    const file = manifest.data.files.find((candidate) => candidate.path === path);
    if (!file || file.key !== publicationArtifactKey(slug, file.path)) { sendError(response, 404, "not_found"); return; }
    const body = await input.artifacts.read(slug, file);
    response.statusCode = 200;
    response.setHeader("content-type", file.contentType);
    response.setHeader("content-length", String(body.byteLength));
    response.setHeader("etag", `"${file.sha256}"`);
    response.setHeader("cache-control", "public, max-age=60, s-maxage=60, must-revalidate");
    response.setHeader("x-publication-sha256", publication.artifactSha256);
    response.end(request.method === "HEAD" ? undefined : Buffer.from(body));
  } catch {
    sendError(response, 503, "temporarily_unavailable");
  }
}

export function requestSlug(hostHeader: string | undefined, baseDomain: string): string | undefined {
  if (!hostHeader || hostHeader.length > 320 || /[\s/@\\]/.test(hostHeader)) return undefined;
  let hostname: string;
  try { hostname = new URL(`https://${hostHeader}`).hostname.toLowerCase(); }
  catch { return undefined; }
  if (!hostname.endsWith(`.${baseDomain}`)) return undefined;
  const subdomain = hostname.slice(0, -(baseDomain.length + 1));
  return /^[a-f0-9]{20}$/.test(subdomain) ? subdomain : undefined;
}

export function requestPath(target: string): string | undefined {
  if (target.length > MAX_REQUEST_TARGET || !target.startsWith("/") || target.startsWith("//") || target.includes("\\") || target.includes("#")) return undefined;
  const pathname = target.split("?", 1)[0]!;
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return undefined;
  const trailingSlash = pathname.length > 1 && pathname.endsWith("/");
  const rawSegments = pathname.slice(1).split("/");
  if (rawSegments.some((segment, index) => !segment && index < rawSegments.length - 1)) return undefined;
  const decoded: string[] = [];
  try {
    for (const segment of rawSegments) {
      if (!segment) continue;
      const value = decodeURIComponent(segment);
      if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") ||
        value.startsWith(".") || /[\u0000-\u001f\u007f]/.test(value) || !/^[A-Za-z0-9._-]{1,255}$/.test(value)) return undefined;
      decoded.push(value);
    }
  } catch { return undefined; }
  if (!decoded.length) return "index.html";
  return trailingSlash ? `${decoded.join("/")}/index.html` : decoded.join("/");
}

function normalizeBaseDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    if (domain !== "games.example.test") throw new TypeError("PUBLISH_BASE_DOMAIN inválido");
  }
  return domain;
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()");
  response.setHeader("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:");
  response.setHeader("cache-control", "no-store");
  response.setHeader("vary", "Host");
}

function sendError(response: ServerResponse, status: number, code: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(code);
}
