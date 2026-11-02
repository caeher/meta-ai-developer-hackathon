import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const maxMetadataBytes = 10 * 1024 * 1024;
const maxTarballBytes = 64 * 1024 * 1024;
const allowedHosts = new Set((process.env.SANDBOX_EGRESS_ALLOWLIST ?? "registry.npmjs.org")
  .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]{0,213}%2f)?[a-z0-9][a-z0-9._-]{0,213}$/i;
const safeMetadataPathPattern = /^(?:@?[A-Za-z0-9%._~-]+(?:%2f[A-Za-z0-9._~-]+)?)(?:\/[A-Za-z0-9%._~-]+)?$/i;

export function validPublicIpv4(address) {
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function validPathname(pathname) {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.length > 2048 || pathname.includes("\\") || /[\u0000-\u0020\u007f]/.test(pathname)) return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  return !decoded.split("/").some((part) => part === "." || part === "..") && !decoded.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(decoded) && !decoded.includes("//");
}

async function resolvePublicIpv4(hostname) {
  if (!allowedHosts.has(hostname) || isIP(hostname) !== 0 || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("egress_host_not_allowed");
  }
  const addresses = await lookup(hostname, { all: true, family: 4, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !validPublicIpv4(address))) throw new Error("egress_destination_not_public");
  return addresses[0].address;
}

function requestPinned(hostname, pathname, address, method) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname,
      servername: hostname,
      port: 443,
      path: pathname,
      method,
      headers: { accept: "application/json, application/octet-stream;q=0.9, */*;q=0.8", "user-agent": "meta-game-sandbox-registry/1" },
      lookup: (_name, _options, callback) => callback(null, address, 4),
      agent: false,
    }, (response) => {
      const chunks = [];
      let total = 0;
      const limit = pathname.endsWith(".tgz") ? maxTarballBytes : maxMetadataBytes;
      response.on("data", (value) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += chunk.length;
        if (total > limit) { response.destroy(new Error("egress_response_too_large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks, total),
      }));
      response.on("error", reject);
    });
    request.setTimeout(20_000, () => request.destroy(new Error("egress_upstream_timeout")));
    request.on("error", reject);
    request.end();
  });
}

async function getUpstream(hostname, pathname, method, redirects = 0) {
  const address = await resolvePublicIpv4(hostname);
  const result = await requestPinned(hostname, pathname, address, method);
  if (result.status >= 300 && result.status < 400) {
    if (redirects >= 3 || typeof result.headers.location !== "string") throw new Error("egress_redirect_rejected");
    const next = validateRedirectLocation(result.headers.location, hostname, allowedHosts);
    if (!next) throw new Error("egress_redirect_rejected");
    return getUpstream(next.hostname, next.pathname, method, redirects + 1);
  }
  return result;
}

function getPackageNameFromMetadataPath(pathname) {
  const segments = pathname.slice(1).split("/");
  if (segments.length > 2) return null;
  const name = segments[0] ?? "";
  if (!packageNamePattern.test(name) || (segments[1] && !/^[A-Za-z0-9%._~-]+$/.test(segments[1]))) return null;
  return name.replace(/%2f/ig, "/");
}

export function validateRegistryRequest(path, hosts) {
  if (typeof path !== "string" || path.includes("?") || path.includes("#")) return null;
  const match = /^\/registry\/([a-z0-9.-]+)\/(.+)$/.exec(path);
  if (!match) return null;
  const hostname = match[1]?.toLowerCase();
  const rawPath = `/${match[2]}`;
  if (!hostname || !hosts.has(hostname) || !validPathname(rawPath)) return null;
  const tarball = /^_tarball\/([A-Za-z0-9_-]+)$/.exec(match[2] ?? "");
  if (!tarball && (!safeMetadataPathPattern.test(rawPath.slice(1)) || !getPackageNameFromMetadataPath(rawPath))) return null;
  const upstreamPath = tarball ? Buffer.from(tarball[1] ?? "", "base64url").toString("utf8") : rawPath;
  if (!validPathname(upstreamPath) || upstreamPath.includes("?") || upstreamPath.includes("#")) return null;
  return { hostname, upstreamPath, tarball: Boolean(tarball) };
}

export function validateRedirectLocation(location, baseHost, hosts) {
  if (typeof location !== "string" || location.length > 2048) return null;
  try {
    const next = new URL(location, `https://${baseHost}`);
    if (next.protocol !== "https:" || next.port || next.username || next.password ||
      !hosts.has(next.hostname.toLowerCase()) || next.search || next.hash || !validPathname(next.pathname)) return null;
    return { hostname: next.hostname.toLowerCase(), pathname: next.pathname };
  } catch { return null; }
}

function rewriteTarballs(metadata, host) {
  if (!metadata || typeof metadata !== "object" || !metadata.versions || typeof metadata.versions !== "object") throw new Error("egress_invalid_registry_response");
  for (const version of Object.values(metadata.versions)) {
    if (!version || typeof version !== "object" || !version.dist || typeof version.dist !== "object") continue;
    const dist = version.dist;
    if (typeof dist.tarball !== "string") continue;
    const source = validateRedirectLocation(dist.tarball, host, allowedHosts);
    if (!source || !dist.tarball.startsWith("https://")) throw new Error("egress_tarball_url_rejected");
    dist.tarball = `http://npm-proxy:8080/registry/${source.hostname}/_tarball/${Buffer.from(source.pathname).toString("base64url")}`;
  }
  return Buffer.from(JSON.stringify(metadata));
}

async function handle(request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ready\n");
    return;
  }
  if (!new Set(["GET", "HEAD"]).has(request.method ?? "")) { response.writeHead(405).end(); return; }
  let path;
  try {
    const url = new URL(request.url ?? "/", "http://npm-proxy");
    if (url.search || url.hash || url.username || url.password || url.host !== "npm-proxy") throw new Error("invalid_proxy_request");
    path = url.pathname;
  } catch { response.writeHead(400).end(); return; }
  const route = validateRegistryRequest(path, allowedHosts);
  if (!route) { response.writeHead(403).end(); return; }
  const { hostname, upstreamPath, tarball } = route;
  try {
    const result = await getUpstream(hostname, upstreamPath, request.method ?? "GET");
    if (result.status < 200 || result.status >= 300) { response.writeHead(result.status === 404 ? 404 : 502).end(); return; }
    const body = tarball || request.method === "HEAD" ? result.body : rewriteTarballs(JSON.parse(result.body.toString("utf8")), hostname);
    response.writeHead(200, {
      "content-type": tarball ? "application/octet-stream" : "application/vnd.npm.install-v1+json",
      "content-length": body.byteLength,
    });
    response.end(body);
  } catch {
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("registry_request_failed\n");
  }
}

const server = createServer((request, response) => { void handle(request, response); });
server.headersTimeout = 5_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 2_000;
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) server.listen(8080, "0.0.0.0");
