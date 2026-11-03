import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { createServer, request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const maxMetadataBytes = 10 * 1024 * 1024;
const maxTarballBytes = 64 * 1024 * 1024;
const allowedHosts = new Set((process.env.SANDBOX_EGRESS_ALLOWLIST ?? "registry.npmjs.org")
  .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
const sandboxId = process.env.SANDBOX_ID ?? "";
const sandboxIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const previewHost = `mg-egress-${sandboxId.toLowerCase()}:8080`;
const previewUpstreamHost = `mg-sandbox-${sandboxId.toLowerCase()}`;
const previewMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
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
  let decoded = pathname;
  for (let pass = 0; pass < 4; pass += 1) {
    if (!safeDecodedPath(decoded)) return false;
    let next;
    try { next = decodeURIComponent(decoded); } catch { return false; }
    if (next === decoded) return true;
    decoded = next;
  }
  return false;
}

function safeDecodedPath(pathname) {
  return pathname.startsWith("/") && !pathname.startsWith("//") && !pathname.includes("\\") &&
    !/[\u0000-\u0020\u007f]/.test(pathname) && !pathname.includes("//") &&
    !pathname.split("/").some((part) => part === "." || part === "..");
}

export async function resolvePublicIpv4(hostname, resolve = lookup) {
  if (!allowedHosts.has(hostname) || isIP(hostname) !== 0 || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("egress_host_not_allowed");
  }
  const addresses = await resolve(hostname, { all: true, family: 4, verbatim: true });
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

export function validatePreviewRequest(requestTarget, host, expectedHost) {
  if (typeof requestTarget !== "string" || typeof host !== "string" || host.toLowerCase() !== expectedHost ||
    requestTarget.length > 4096 || !requestTarget.startsWith("/") || requestTarget.startsWith("//") || requestTarget.includes("#") || requestTarget.includes("\\")) return null;
  const question = requestTarget.indexOf("?");
  const rawPath = question < 0 ? requestTarget : requestTarget.slice(0, question);
  const query = question < 0 ? "" : requestTarget.slice(question);
  const prefix = "/__preview";
  if (!rawPath.startsWith(`${prefix}/`) || query.length > 2048 || /[\u0000-\u0020\u007f#]/.test(query)) return null;
  const gamePath = rawPath.slice(prefix.length);
  if (!validPathname(gamePath) || /%(?:2f|5c)/i.test(gamePath)) return null;
  return { gamePath, query };
}

function validPreviewOrigin(value) {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.origin === value && /^[a-z0-9.-]+$/.test(origin.hostname);
  } catch { return false; }
}

function previewRequestHeaders(request) {
  const headers = { host: "localhost:4173" };
  for (const name of ["accept", "accept-encoding", "accept-language", "cache-control", "content-type", "content-length", "if-modified-since", "if-none-match", "range", "user-agent"]) {
    const value = request.headers[name];
    if (typeof value === "string" && value.length <= 4096) headers[name] = value;
  }
  const origin = request.headers["x-preview-origin"];
  if (validPreviewOrigin(origin)) headers.origin = origin;
  return headers;
}

function previewResponseHeaders(headers) {
  const result = {};
  for (const name of ["content-type", "content-length", "content-encoding", "etag", "last-modified", "accept-ranges", "content-range"]) {
    const value = headers[name];
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function handlePreview(request, response, parsed) {
  if (!previewMethods.has(request.method ?? "")) { response.writeHead(405).end(); return; }
  const upstream = httpRequest({
    hostname: previewUpstreamHost,
    port: 4173,
    method: request.method,
    path: `${parsed.gamePath}${parsed.query}`,
    headers: previewRequestHeaders(request),
    timeout: 30_000,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, previewResponseHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(response);
  });
  upstream.once("timeout", () => upstream.destroy(new Error("preview_upstream_timeout")));
  upstream.once("error", () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); });
  request.once("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function handlePreviewUpgrade(request, socket, head, parsed) {
  const key = request.headers["sec-websocket-key"];
  if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket" ||
    request.headers.connection?.toLowerCase().split(/\s*,\s*/).includes("upgrade") !== true ||
    typeof key !== "string" || key.length > 128 || request.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const headers = previewRequestHeaders(request);
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  headers["sec-websocket-key"] = key;
  headers["sec-websocket-version"] = "13";
  for (const name of ["sec-websocket-protocol", "sec-websocket-extensions"]) {
    const value = request.headers[name];
    if (typeof value === "string" && value.length <= 2048) headers[name] = value;
  }
  const upstream = httpRequest({ hostname: previewUpstreamHost, port: 4173, method: "GET", path: `${parsed.gamePath}${parsed.query}`, headers, timeout: 15_000 });
  upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
    const forwarded = response.rawHeaders.flatMap((name, index, all) => {
      if (index % 2 !== 0) return [];
      const value = all[index + 1];
      return value && new Set(["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]).has(name.toLowerCase())
        ? [`${name}: ${value}`]
        : [];
    });
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${forwarded.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    socket.once("close", () => upstreamSocket.destroy());
    upstreamSocket.once("close", () => socket.destroy());
  });
  upstream.once("response", (response) => { response.resume(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
  upstream.once("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
  upstream.end();
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
  const requestHost = request.headers.host?.toLowerCase();
  const preview = validatePreviewRequest(request.url, requestHost, previewHost);
  if (preview) { handlePreview(request, response, preview); return; }
  if (!new Set(["GET", "HEAD"]).has(request.method ?? "")) { response.writeHead(405).end(); return; }
  let path;
  try {
    const url = new URL(request.url ?? "/", "http://npm-proxy");
    if (url.search || url.hash || url.username || url.password || requestHost !== "npm-proxy:8080") throw new Error("invalid_proxy_request");
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
server.on("upgrade", (request, socket, head) => {
  const parsed = validatePreviewRequest(request.url, request.headers.host?.toLowerCase(), previewHost);
  if (!sandboxIdPattern.test(sandboxId) || !parsed) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
  handlePreviewUpgrade(request, socket, head, parsed);
});
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!sandboxIdPattern.test(sandboxId)) throw new Error("preview_proxy_sandbox_identity_invalid");
  server.listen(8080, "0.0.0.0");
}
