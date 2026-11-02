import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import {
  PREVIEW_EGRESS_PROXY_PORT,
  PREVIEW_SESSION_COOKIE,
  PreviewExchangeInputSchema,
  PreviewSessionSchema,
  type PreviewGrantClaims,
  type PreviewSession,
} from "@meta-game/contracts";
import {
  hashPreviewSessionId,
  verifyPreviewGrant,
  type PreviewVerifierKeyRing,
  type PreviewStore,
} from "@meta-game/preview";
import { previewProjectHostname } from "@meta-game/preview";

export type GatewayPreviewTarget = Readonly<{
  ownerClerkUserId: string;
  projectId: string;
  sandboxId: string;
  devServerPort: number;
  leaseExpiresAt: Date;
}>;

type ProxyAddress = Readonly<{ hostname: string; port: number }>;
type AuthorizedRequest = Readonly<{ session: PreviewSession; target: GatewayPreviewTarget; sessionIdHash: string }>;
type SocketPair = { browser: Socket; upstream: Socket; timer: NodeJS.Timeout; projectId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const safeRequestHeaders = ["accept", "accept-encoding", "accept-language", "cache-control", "content-type", "if-modified-since", "if-none-match", "range", "user-agent"];
const safeResponseHeaders = ["content-type", "content-length", "content-encoding", "etag", "last-modified", "accept-ranges", "content-range"];
const maxBodyBytes = 4 * 1024 * 1024;
const maxExchangeBytes = 16 * 1024;

function csp(host: string, appOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' wss://${host}`,
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${appOrigin}`,
  ].join("; ");
}

function securityHeaders(host: string, appOrigin: string): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": csp(host, appOrigin),
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "cross-origin-resource-policy": "cross-origin",
  };
}

function denial(response: ServerResponse, host: string, appOrigin: string, status = 404): void {
  const body = "Preview unavailable\n";
  response.writeHead(status, {
    ...securityHeaders(host, appOrigin),
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function projectFromHost(rawHost: string | undefined, baseDomain: string): { projectId: string; hostname: string } | undefined {
  if (!rawHost || rawHost.length > 280 || rawHost !== rawHost.toLowerCase() || rawHost.includes(",") || rawHost.includes(":")) return undefined;
  const suffix = `.${baseDomain}`;
  if (!rawHost.endsWith(suffix)) return undefined;
  const projectId = rawHost.slice(0, -suffix.length);
  const hostname = previewProjectHostname(projectId, baseDomain);
  return hostname === rawHost ? { projectId: projectId.toLowerCase(), hostname } : undefined;
}

function parseRequestTarget(rawUrl: string | undefined): { path: string; query: string } | undefined {
  if (!rawUrl || rawUrl.length > 4096 || !rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.includes("\\") || rawUrl.includes("#") || /[\u0000-\u0020\u007f]/.test(rawUrl)) return undefined;
  const question = rawUrl.indexOf("?");
  const path = question < 0 ? rawUrl : rawUrl.slice(0, question);
  const query = question < 0 ? "" : rawUrl.slice(question);
  if (query.length > 2048 || /[\u0000-\u0020\u007f#]/.test(query) || /%(?:2f|5c)/i.test(path)) return undefined;
  try {
    const decoded = decodeURIComponent(path);
    if (decoded.includes("\\") || decoded.includes("//") || /[\u0000-\u001f\u007f]/.test(decoded) || decoded.split("/").some((part) => part === "." || part === "..")) return undefined;
  } catch { return undefined; }
  return { path: path || "/", query };
}

function readSessionCookie(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length > 4096) return undefined;
  const values = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${PREVIEW_SESSION_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]?.slice(PREVIEW_SESSION_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{40,64}$/.test(value) ? value : undefined;
}

function rateKey(scope: string, value: string): string {
  return createHash("sha256").update(`${scope}\0${value}`).digest("hex");
}

async function readExchangeBody(request: IncomingMessage): Promise<{ input: unknown; form: boolean }> {
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") throw new Error("invalid_content_type");
  const length = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > maxExchangeBytes) throw new Error("body_too_large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maxExchangeBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks, total).toString("utf8");
  if (contentType === "application/json") return { input: JSON.parse(body) as unknown, form: false };
  const form = new URLSearchParams(body);
  const grants = form.getAll("grant");
  if (grants.length !== 1 || [...form.keys()].some((key) => key !== "grant")) throw new Error("invalid_form");
  return { input: { grant: grants[0] }, form: true };
}

function allowedOrigin(request: IncomingMessage, expected: string): boolean {
  return typeof request.headers.origin === "string" && request.headers.origin === expected;
}

function corsHeaders(appOrigin: string): Record<string, string> {
  return {
    "access-control-allow-origin": appOrigin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function clientIp(request: IncomingMessage): string {
  const proxied = request.headers["x-real-ip"];
  if (typeof proxied === "string" && isIP(proxied) !== 0) return proxied;
  return request.socket.remoteAddress ?? "unknown";
}

function safeProxyHeaders(request: IncomingMessage, origin: string, proxyHost: string): Record<string, string> {
  const headers: Record<string, string> = { host: proxyHost };
  for (const name of safeRequestHeaders) {
    const value = request.headers[name];
    if (typeof value === "string" && value.length <= 4096) headers[name] = value;
  }
  headers.host = proxyHost;
  headers["x-preview-origin"] = origin;
  return headers;
}

function safeResponseHeaderMap(headers: IncomingMessage["headers"], host: string, appOrigin: string): Record<string, string> {
  const result: Record<string, string> = securityHeaders(host, appOrigin);
  for (const name of safeResponseHeaders) {
    const value = headers[name];
    if (typeof value === "string") result[name] = value;
  }
  const location = headers.location;
  if (typeof location === "string" && location.length <= 4096) {
    if (location.startsWith("/") && parseRequestTarget(location)) result.location = location;
    else {
      try {
        const parsed = new URL(location);
        if (parsed.origin === "http://localhost:4173" && parseRequestTarget(`${parsed.pathname}${parsed.search}`)) result.location = `${parsed.pathname}${parsed.search}`;
      } catch { /* Hide upstream redirects outside the fixed Vite origin. */ }
    }
  }
  return result;
}

function websocketHeaders(request: IncomingMessage, origin: string): Record<string, string> | undefined {
  if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket" || request.headers.connection?.toLowerCase().split(/\s*,\s*/).includes("upgrade") !== true) return undefined;
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  if (typeof key !== "string" || key.length > 128 || version !== "13") return undefined;
  const headers: Record<string, string> = {
    connection: "Upgrade",
    upgrade: "websocket",
    host: "mg-egress-preview.invalid",
    origin,
    "sec-websocket-key": key,
    "sec-websocket-version": version,
    "x-preview-origin": origin,
  };
  for (const name of ["sec-websocket-protocol", "sec-websocket-extensions"] as const) {
    const value = request.headers[name];
    if (typeof value === "string" && value.length <= 2048) headers[name] = value;
  }
  return headers;
}

function writeUpgradeFailure(socket: Socket, status: number, text: string): void {
  if (socket.destroyed) return;
  const body = `${text}\n`;
  socket.end(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Bad Gateway"}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: private, no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n\r\n${body}`);
}

function sendCloseFrame(socket: Socket, code: number): void {
  if (socket.destroyed || !socket.writable) return;
  const frame = Buffer.from([0x88, 0x02, (code >> 8) & 0xff, code & 0xff]);
  socket.write(frame);
}

export function createPreviewGateway(options: {
  baseDomain: string;
  appOrigin: string;
  sessionTtlSeconds: number;
  store: PreviewStore;
  keyRing: PreviewVerifierKeyRing;
  resolveTarget(projectId: string): Promise<GatewayPreviewTarget | undefined>;
  proxyAddress?(target: GatewayPreviewTarget): ProxyAddress;
  clock?: () => number;
}) {
  const clock = options.clock ?? Date.now;
  const sockets = new Map<string, Set<SocketPair>>();
  const connections = new Set<Socket>();
  let stopRevocations: (() => Promise<void>) | undefined;

  async function resolveAuthorization(request: IncomingMessage, projectId: string): Promise<AuthorizedRequest | undefined> {
    const sessionId = readSessionCookie(request);
    if (!sessionId) return undefined;
    const sessionIdHash = hashPreviewSessionId(sessionId);
    const session = await options.store.readSession(sessionIdHash, projectId, Math.floor(clock() / 1000));
    if (!session) return undefined;
    const target = await options.resolveTarget(projectId);
    if (!target || target.projectId !== projectId || target.ownerClerkUserId !== session.userId ||
      target.devServerPort !== 4173 || target.leaseExpiresAt.getTime() <= clock() || !uuidPattern.test(target.sandboxId)) return undefined;
    return { session, target, sessionIdHash };
  }

  async function exchangeSession(request: IncomingMessage, response: ServerResponse, projectId: string, host: string): Promise<void> {
    const headers = { ...securityHeaders(host, options.appOrigin), ...corsHeaders(options.appOrigin), "content-type": "application/json; charset=utf-8" };
    if (request.method === "OPTIONS") {
      if (!allowedOrigin(request, options.appOrigin)) {
        response.writeHead(403, headers).end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      response.writeHead(204, headers).end();
      return;
    }
    if (!allowedOrigin(request, options.appOrigin)) {
      response.writeHead(403, headers).end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    if (request.method === "GET") {
      const authorization = await resolveAuthorization(request, projectId);
      if (!authorization) {
        response.writeHead(404, headers).end(JSON.stringify({ error: "preview_unavailable" }));
        return;
      }
      response.writeHead(204, headers).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, headers).end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const allowed = await options.store.allowRateLimit(rateKey(`exchange:${projectId}`, clientIp(request)), 60, 60);
    if (!allowed) {
      response.writeHead(429, headers).end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    let input: ReturnType<typeof PreviewExchangeInputSchema.parse>;
    let formExchange = false;
    try {
      const body = await readExchangeBody(request);
      input = PreviewExchangeInputSchema.parse(body.input);
      formExchange = body.form;
    }
    catch {
      response.writeHead(400, headers).end(JSON.stringify({ error: "invalid_request" }));
      return;
    }
    let claims: PreviewGrantClaims;
    try { claims = verifyPreviewGrant(input.grant, options.keyRing, Math.floor(clock() / 1000)); }
    catch {
      response.writeHead(404, headers).end(JSON.stringify({ error: "preview_unavailable" }));
      return;
    }
    if (claims.projectId !== projectId) {
      response.writeHead(404, headers).end(JSON.stringify({ error: "preview_unavailable" }));
      return;
    }
    const target = await options.resolveTarget(projectId);
    if (!target || target.projectId !== projectId || target.ownerClerkUserId !== claims.userId ||
      target.devServerPort !== 4173 || target.leaseExpiresAt.getTime() <= clock()) {
      response.writeHead(404, headers).end(JSON.stringify({ error: "preview_unavailable" }));
      return;
    }
    const nowSeconds = Math.floor(clock() / 1000);
    const grantTtlSeconds = claims.exp - nowSeconds;
    if (grantTtlSeconds < 1) {
      response.writeHead(404, headers).end(JSON.stringify({ error: "preview_unavailable" }));
      return;
    }
    const sessionId = randomBytes(32).toString("base64url");
    const session = PreviewSessionSchema.parse({
      userId: claims.userId,
      projectId,
      epoch: claims.epoch,
      expiresAt: nowSeconds + options.sessionTtlSeconds,
    });
    const consumed = await options.store.createSessionFromGrant({
      projectId,
      grantId: claims.jti,
      epoch: claims.epoch,
      grantTtlSeconds,
      sessionIdHash: hashPreviewSessionId(sessionId),
      session,
      sessionTtlSeconds: options.sessionTtlSeconds,
    });
    if (!consumed) {
      response.writeHead(404, headers).end(JSON.stringify({ error: "preview_unavailable" }));
      return;
    }
    response.writeHead(formExchange ? 303 : 200, {
      ...headers,
      "set-cookie": `${PREVIEW_SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${options.sessionTtlSeconds}; Secure; HttpOnly; SameSite=None; Partitioned`,
      ...(formExchange ? { location: "/" } : {}),
    });
    response.end(formExchange ? undefined : JSON.stringify({ ok: true, expiresAt: new Date(session.expiresAt * 1000).toISOString() }));
  }

  function proxyAddress(target: GatewayPreviewTarget): ProxyAddress {
    return options.proxyAddress?.(target) ?? {
      hostname: `mg-egress-${target.sandboxId}`,
      port: PREVIEW_EGRESS_PROXY_PORT,
    };
  }

  function validProxyAddress(address: ProxyAddress): boolean {
    return /^[a-z0-9.-]{1,253}$/.test(address.hostname) && Number.isSafeInteger(address.port) &&
      (options.proxyAddress ? address.port >= 1024 && address.port <= 65535 : address.port === PREVIEW_EGRESS_PROXY_PORT);
  }

  function handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (request.method === "GET" && request.url === "/healthz" && new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]).has(request.socket.remoteAddress ?? "")) {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      }).end("ready\n");
      return;
    }
    const route = projectFromHost(request.headers.host, options.baseDomain);
    const host = route?.hostname ?? `invalid.${options.baseDomain}`;
    if (!route) { denial(response, host, options.appOrigin); return; }
    const parsedTarget = parseRequestTarget(request.url);
    if (!parsedTarget) { denial(response, host, options.appOrigin); return; }
    if (parsedTarget.path === "/__session") {
      if (parsedTarget.query) { denial(response, route.hostname, options.appOrigin, 400); return; }
      void exchangeSession(request, response, route.projectId, route.hostname).catch(() => {
        if (!response.headersSent) denial(response, route.hostname, options.appOrigin, 503);
        else response.destroy();
      });
      return;
    }
    if (!allowedMethods.has(request.method ?? "")) { denial(response, route.hostname, options.appOrigin, 405); return; }
    void (async () => {
      const authorization = await resolveAuthorization(request, route.projectId);
      if (!authorization) { denial(response, route.hostname, options.appOrigin); return; }
      const allowed = await options.store.allowRateLimit(rateKey(`http:${route.projectId}:${authorization.session.userId}`, "requests"), 1200, 60);
      if (!allowed) { denial(response, route.hostname, options.appOrigin, 429); return; }
      const upstreamUrl = `/__preview${parsedTarget.path}${parsedTarget.query}`;
      const origin = `https://${route.hostname}`;
      const address = proxyAddress(authorization.target);
      if (!validProxyAddress(address)) {
        denial(response, route.hostname, options.appOrigin, 503);
        return;
      }
      const upstream = httpRequest({
        hostname: address.hostname,
        port: address.port,
        method: request.method,
        path: upstreamUrl,
        headers: safeProxyHeaders(request, origin, `${address.hostname}:${address.port}`),
        timeout: 30_000,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, safeResponseHeaderMap(upstreamResponse.headers, route.hostname, options.appOrigin));
        upstreamResponse.pipe(response);
      });
      let received = 0;
      request.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBodyBytes) {
          upstream.destroy();
          denial(response, route.hostname, options.appOrigin, 413);
        }
      });
      request.once("aborted", () => upstream.destroy());
      request.once("error", () => upstream.destroy());
      upstream.once("timeout", () => upstream.destroy(new Error("preview_upstream_timeout")));
      upstream.once("error", () => {
        if (!response.headersSent) denial(response, route.hostname, options.appOrigin, 502);
        else response.destroy();
      });
      request.pipe(upstream);
    })().catch(() => {
      if (!response.headersSent) denial(response, route.hostname, options.appOrigin, 503);
      else response.destroy();
    });
  }

  function removeSocketPair(pair: SocketPair): void {
    clearTimeout(pair.timer);
    const active = sockets.get(pair.projectId);
    active?.delete(pair);
    if (active?.size === 0) sockets.delete(pair.projectId);
  }

  function closeSocketPair(pair: SocketPair): void {
    removeSocketPair(pair);
    sendCloseFrame(pair.browser, 1008);
    sendCloseFrame(pair.upstream, 1008);
    const timer = setTimeout(() => {
      pair.browser.destroy();
      pair.upstream.destroy();
    }, 250);
    timer.unref();
  }

  function handleUpgrade(request: IncomingMessage, browser: Socket, head: Buffer): void {
    const route = projectFromHost(request.headers.host, options.baseDomain);
    if (!route) { writeUpgradeFailure(browser, 404, "Preview unavailable"); return; }
    const parsedTarget = parseRequestTarget(request.url);
    const origin = `https://${route.hostname}`;
    const headers = websocketHeaders(request, origin);
    if (!parsedTarget || !headers || request.headers.origin !== origin) {
      writeUpgradeFailure(browser, 404, "Preview unavailable");
      return;
    }
    void (async () => {
      const authorization = await resolveAuthorization(request, route.projectId);
      if (!authorization) { writeUpgradeFailure(browser, 404, "Preview unavailable"); return; }
      const allowed = await options.store.allowRateLimit(rateKey(`ws:${route.projectId}:${authorization.session.userId}`, "upgrades"), 60, 60);
      if (!allowed) { writeUpgradeFailure(browser, 404, "Preview unavailable"); return; }
      const address = proxyAddress(authorization.target);
      if (!validProxyAddress(address)) {
        writeUpgradeFailure(browser, 404, "Preview unavailable");
        return;
      }
      headers.host = `${address.hostname}:${address.port}`;
      const upstream = httpRequest({
        hostname: address.hostname,
        port: address.port,
        method: "GET",
        path: `/__preview${parsedTarget.path}${parsedTarget.query}`,
        headers,
        timeout: 15_000,
      });
      let paired = false;
      upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
        const pair: SocketPair = {
          browser,
          upstream: upstreamSocket,
          projectId: route.projectId,
          timer: setTimeout(() => closeSocketPair(pair), Math.max(1, authorization.session.expiresAt * 1000 - clock())),
        };
        pair.timer.unref();
        const active = sockets.get(route.projectId) ?? new Set<SocketPair>();
        active.add(pair);
        sockets.set(route.projectId, active);
        paired = true;
        void resolveAuthorization(request, route.projectId).then((fresh) => {
          if (!fresh || fresh.sessionIdHash !== authorization.sessionIdHash) {
            removeSocketPair(pair);
            upstreamSocket.destroy();
            writeUpgradeFailure(browser, 404, "Preview unavailable");
            return;
          }
          const statusLine = `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}`;
          const websocketResponseHeaders = upstreamResponse.rawHeaders.flatMap((value, index, all) => {
            if (index % 2 !== 0) return [];
            const name = value.toLowerCase();
            const headerValue = all[index + 1];
            return headerValue && new Set(["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]).has(name)
              ? [`${value}: ${headerValue}`]
              : [];
          });
          const responseHeaders = [
            "Upgrade: websocket",
            "Connection: Upgrade",
            ...websocketResponseHeaders,
            ...Object.entries(securityHeaders(route.hostname, options.appOrigin)).map(([name, value]) => `${name}: ${value}`),
            "Cache-Control: private, no-store",
          ];
          browser.write(`${statusLine}\r\n${responseHeaders.join("\r\n")}\r\n\r\n`);
          if (upstreamHead.length) browser.write(upstreamHead);
          if (head.length) upstreamSocket.write(head);
          browser.pipe(upstreamSocket);
          upstreamSocket.pipe(browser);
          browser.on("error", () => { removeSocketPair(pair); upstreamSocket.destroy(); });
          upstreamSocket.on("error", () => { removeSocketPair(pair); browser.destroy(); });
          browser.once("close", () => { removeSocketPair(pair); upstreamSocket.destroy(); });
          upstreamSocket.once("close", () => { removeSocketPair(pair); browser.destroy(); });
        }).catch(() => {
          removeSocketPair(pair);
          upstreamSocket.destroy();
          writeUpgradeFailure(browser, 404, "Preview unavailable");
        });
      });
      upstream.once("response", (upstreamResponse) => {
        upstreamResponse.resume();
        if (!browser.destroyed) writeUpgradeFailure(browser, 404, "Preview unavailable");
      });
      upstream.once("error", () => {
        if (!browser.destroyed) writeUpgradeFailure(browser, 404, "Preview unavailable");
      });
      upstream.once("close", () => { if (!paired && !browser.destroyed) browser.destroy(); });
      browser.once("close", () => upstream.destroy());
      upstream.end();
    })().catch(() => writeUpgradeFailure(browser, 404, "Preview unavailable"));
  }

  const server: Server = createServer((request, response) => handleHttp(request, response));
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 2_000;
  server.maxHeadersCount = 100;
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.on("upgrade", handleUpgrade);

  return {
    server,
    async start(port: number, host = "0.0.0.0"): Promise<void> {
      stopRevocations = await options.store.subscribeRevocations((projectId) => {
        for (const pair of [...(sockets.get(projectId) ?? [])]) closeSocketPair(pair);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolve(); });
      });
    },
    async close(): Promise<void> {
      await stopRevocations?.();
      for (const active of sockets.values()) for (const pair of active) closeSocketPair(pair);
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
