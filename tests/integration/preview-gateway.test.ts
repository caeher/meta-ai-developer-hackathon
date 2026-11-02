import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PREVIEW_GRANT_AUDIENCE,
  PREVIEW_GRANT_ISSUER,
  PREVIEW_SESSION_COOKIE,
  type PreviewSession,
} from "@meta-game/contracts";
import { createPreviewGrantHandlers } from "../../apps/web/server/preview/handlers";
import { createPreviewGateway, type GatewayPreviewTarget } from "../../apps/preview-gateway/src/gateway";
import { loadPreviewVerifierKeyRing, signPreviewGrant, verifyPreviewGrant, type PreviewKeyRing, type PreviewStore } from "@meta-game/preview";

const ownerA = "user_previewOwnerA";
const ownerB = "user_previewOwnerB";
const projectA = "11111111-1111-4111-8111-111111111111";
const projectB = "22222222-2222-4222-8222-222222222222";
const sandboxA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sandboxB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const appOrigin = "http://localhost:3000";
const baseDomain = "preview.example.test";
const hostA = `${projectA}.${baseDomain}`;

function createKeyRing(): PreviewKeyRing {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { activeKeyId: "test-2026", privateKey: keys.privateKey, publicKeys: new Map([["test-2026", keys.publicKey]]) };
}

class MemoryPreviewStore implements PreviewStore {
  readonly epochs = new Map<string, number>();
  readonly consumedGrants = new Set<string>();
  readonly sessions = new Map<string, PreviewSession>();
  readonly listeners = new Set<(projectId: string) => void>();
  readonly rates = new Map<string, number>();

  async getProjectEpoch(projectId: string) { return this.epochs.get(projectId) ?? 0; }

  async createSessionFromGrant(input: Parameters<PreviewStore["createSessionFromGrant"]>[0]) {
    if ((this.epochs.get(input.projectId) ?? 0) !== input.epoch || this.consumedGrants.has(input.grantId)) return false;
    this.consumedGrants.add(input.grantId);
    this.sessions.set(input.sessionIdHash, input.session);
    return true;
  }

  async readSession(sessionIdHash: string, projectId: string, nowSeconds = Math.floor(Date.now() / 1000)) {
    const session = this.sessions.get(sessionIdHash);
    if (!session || session.projectId !== projectId || session.epoch !== (this.epochs.get(projectId) ?? 0) || session.expiresAt <= nowSeconds) return undefined;
    return session;
  }

  async revokeProject(projectId: string) {
    const epoch = (this.epochs.get(projectId) ?? 0) + 1;
    this.epochs.set(projectId, epoch);
    for (const listener of this.listeners) listener(projectId);
    return epoch;
  }

  async allowRateLimit(key: string) {
    const count = (this.rates.get(key) ?? 0) + 1;
    this.rates.set(key, count);
    return true;
  }

  async subscribeRevocations(listener: (projectId: string) => void) {
    this.listeners.add(listener);
    return async () => { this.listeners.delete(listener); };
  }

  async close() {}
}

function target(projectId = projectA, ownerClerkUserId = ownerA): GatewayPreviewTarget {
  return {
    ownerClerkUserId,
    projectId,
    sandboxId: sandboxA,
    devServerPort: 4173,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
}

function grant(keyRing: PreviewKeyRing, projectId = projectA, userId = ownerA, epoch = 0, nowSeconds = Math.floor(Date.now() / 1000)) {
  return signPreviewGrant({
    iss: PREVIEW_GRANT_ISSUER,
    sub: userId,
    userId,
    projectId,
    aud: PREVIEW_GRANT_AUDIENCE,
    iat: nowSeconds,
    exp: nowSeconds + 60,
    jti: randomUUID(),
    epoch,
  }, keyRing);
}

function signedUnvalidatedGrant(keyRing: PreviewKeyRing, changes: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT", kid: keyRing.activeKeyId });
  const payload = encode({
    iss: PREVIEW_GRANT_ISSUER,
    sub: ownerA,
    userId: ownerA,
    projectId: projectA,
    aud: PREVIEW_GRANT_AUDIENCE,
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    epoch: 0,
    ...changes,
  });
  const input = `${header}.${payload}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(input), keyRing.privateKey).toString("base64url");
  return `${input}.${signature}`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("server_address_missing"));
      else resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port: number, path: string, headers: Record<string, string>, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function readRawUntil(socket: Socket, pattern: Buffer, timeoutMs = 3000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => reject(new Error("socket_read_timeout")), timeoutMs);
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      const result = Buffer.concat(chunks);
      if (result.includes(pattern)) {
        clearTimeout(timeout);
        socket.off("data", onData);
        resolve(result);
      }
    };
    socket.on("data", onData);
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

describe("preview privada: grants y proxy HTTP/WebSocket", () => {
  let keyRing: PreviewKeyRing;
  let store: MemoryPreviewStore;
  let backend: Server;
  let backendPort: number;
  let gateway: ReturnType<typeof createPreviewGateway>;
  let gatewayPort: number;
  const backendRequests: Array<{ path?: string; host?: string; cookie?: string; authorization?: string; origin?: string; previewOrigin?: string; clerk?: string }> = [];
  const backendSockets = new Set<Duplex>();
  let activeBrowserSocket: Socket | undefined;

  beforeEach(async () => {
    keyRing = createKeyRing();
    store = new MemoryPreviewStore();
    backendRequests.length = 0;
    backend = createHttpServer((req, res) => {
      backendRequests.push({
        path: req.url,
        host: req.headers.host,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
        origin: req.headers.origin,
        previewOrigin: req.headers["x-preview-origin"] as string | undefined,
        clerk: req.headers["x-clerk-auth"] as string | undefined,
      });
      res.writeHead(req.url === "/__preview/missing.js" ? 404 : 200, {
        "content-type": req.url?.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
        "set-cookie": "platform=secret; Domain=preview.example.test",
        "content-security-policy": "default-src *",
      });
      res.end(req.url === "/__preview/assets/game.js" ? "window.privateGame = true" :
        req.url === "/__preview/missing.js" ? "upstream detail" : "<html>my private game</html>");
    });
    backend.on("upgrade", (req, socket) => {
      backendSockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => backendSockets.delete(socket));
      backendRequests.push({
        path: req.url,
        host: req.headers.host,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
        origin: req.headers.origin,
        previewOrigin: req.headers["x-preview-origin"] as string | undefined,
        clerk: req.headers["x-clerk-auth"] as string | undefined,
      });
      const key = req.headers["sec-websocket-key"] ?? "";
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: upstream=secret\r\nServer: game-dev\r\n\r\n`);
    });
    backendPort = await listen(backend);
    gateway = createPreviewGateway({
      baseDomain,
      appOrigin,
      sessionTtlSeconds: 900,
      store,
      keyRing,
      resolveTarget: async (projectId) => projectId === projectA
        ? target()
        : projectId === projectB ? { ...target(projectB, ownerB), sandboxId: sandboxB } : undefined,
      proxyAddress: () => ({ hostname: "127.0.0.1", port: backendPort }),
    });
    await gateway.start(0, "127.0.0.1");
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("gateway_address_missing");
    gatewayPort = address.port;
  });

  afterEach(async () => {
    activeBrowserSocket?.destroy();
    for (const socket of backendSockets) socket.destroy();
    await gateway.close();
    await closeServer(backend);
  });

  async function exchange(token = grant(keyRing), host = hostA) {
    return request(gatewayPort, "/__session", {
      host,
      origin: appOrigin,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(JSON.stringify({ grant: token }))),
    }, "POST", JSON.stringify({ grant: token }));
  }

  it("canjea grants de un uso, ata owner y proyecto y revoca por epoch", async () => {
    const token = grant(keyRing);
    const first = await exchange(token);
    expect(first.status).toBe(200);
    expect(first.headers["access-control-allow-origin"]).toBe(appOrigin);
    expect(first.headers["access-control-allow-credentials"]).toBe("true");
    const cookieHeader = first.headers["set-cookie"];
    expect(cookieHeader).toEqual(expect.arrayContaining([expect.stringContaining(`${PREVIEW_SESSION_COOKIE}=`)]));
    expect(cookieHeader).toEqual(expect.arrayContaining([expect.stringContaining("Path=/;")]));
    expect(cookieHeader).toEqual(expect.arrayContaining([expect.stringContaining("; Secure;")]));
    expect(cookieHeader).toEqual(expect.arrayContaining([expect.stringContaining("HttpOnly; SameSite=None; Partitioned")]));
    expect(cookieHeader).not.toEqual(expect.arrayContaining([expect.stringContaining("Domain=")]));
    expect(first.body).not.toContain(token);

    const replay = await exchange(token);
    expect(replay.status).toBe(404);
    expect(replay.body).toBe(JSON.stringify({ error: "preview_unavailable" }));

    const wrongProject = await exchange(grant(keyRing, projectB, ownerA));
    expect(wrongProject.status).toBe(404);
    const wrongAudience = await exchange(signedUnvalidatedGrant(keyRing, { aud: "another-service" }));
    expect(wrongAudience.status).toBe(404);
    const wrongOwnerToken = grant(keyRing, projectA, ownerB);
    expect((await exchange(wrongOwnerToken)).status).toBe(404);

    const ownerBSession = await exchange(grant(keyRing, projectB, ownerB), `${projectB}.${baseDomain}`);
    expect(ownerBSession.status).toBe(200);
    const stolenOwnerBCookie = String(ownerBSession.headers["set-cookie"]).split(";")[0] ?? "";
    const crossProject = await request(gatewayPort, "/index.html", { host: hostA, cookie: stolenOwnerBCookie });
    expect(crossProject.status).toBe(404);
    expect(crossProject.body).toBe("Preview unavailable\n");
    const anonymous = await request(gatewayPort, "/index.html", { host: hostA });
    expect(anonymous.status).toBe(crossProject.status);
    expect(anonymous.body).toBe(crossProject.body);
    expect(crossProject.body).toBe("Preview unavailable\n");

    const next = await exchange(grant(keyRing));
    expect(next.status).toBe(200);
    await store.revokeProject(projectA);
    const revokedCookie = String(next.headers["set-cookie"]).split(";")[0] ?? "";
    const denied = await request(gatewayPort, "/", { host: hostA, cookie: revokedCookie });
    expect(denied.status).toBe(404);
  });

  it("comprueba la cookie particionada y admite el canje de primer nivel sin poner el grant en la URL", async () => {
    const preflight = await request(gatewayPort, "/__session", {
      host: hostA,
      origin: appOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    }, "OPTIONS");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(appOrigin);
    expect(preflight.headers["access-control-allow-methods"]).toContain("GET");
    expect(preflight.headers["access-control-allow-methods"]).not.toContain("*");

    const anonymousHealth = await request(gatewayPort, "/__session", { host: hostA, origin: appOrigin }, "GET");
    expect(anonymousHealth.status).toBe(404);
    expect(anonymousHealth.headers["access-control-allow-origin"]).toBe(appOrigin);

    const jsonSession = await exchange();
    const cookie = String(jsonSession.headers["set-cookie"]).split(";")[0] ?? "";
    const health = await request(gatewayPort, "/__session", { host: hostA, origin: appOrigin, cookie }, "GET");
    expect(health.status).toBe(204);
    expect(health.headers["cache-control"]).toBe("private, no-store");

    const token = grant(keyRing);
    const formBody = new URLSearchParams({ grant: token }).toString();
    const firstPartySession = await request(gatewayPort, "/__session", {
      host: hostA,
      origin: appOrigin,
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(formBody)),
    }, "POST", formBody);
    expect(firstPartySession.status).toBe(303);
    expect(firstPartySession.headers.location).toBe("/");
    expect(firstPartySession.body).toBe("");
    expect(firstPartySession.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining("Secure; HttpOnly; SameSite=None; Partitioned"),
    ]));
    expect(firstPartySession.body).not.toContain(token);

    const queryGrant = await request(gatewayPort, `/__session?grant=${encodeURIComponent(grant(keyRing))}`, { host: hostA, origin: appOrigin }, "GET");
    expect(queryGrant.status).toBe(400);
  });

  it("rechaza firma alterada, grant expirado y epoch anterior; conserva claves previas durante rotación", async () => {
    const valid = grant(keyRing);
    const validParts = valid.split(".");
    const signature = validParts[2] ?? "";
    const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect((await exchange(`${validParts[0]}.${validParts[1]}.${changedSignature}`)).status).toBe(404);

    const now = Math.floor(Date.now() / 1000);
    const expired = signPreviewGrant({
      iss: PREVIEW_GRANT_ISSUER,
      sub: ownerA,
      userId: ownerA,
      projectId: projectA,
      aud: PREVIEW_GRANT_AUDIENCE,
      iat: now - 61,
      exp: now - 1,
      jti: randomUUID(),
      epoch: 0,
    }, keyRing);
    expect((await exchange(expired)).status).toBe(404);

    const staleEpoch = grant(keyRing);
    await store.revokeProject(projectA);
    expect((await exchange(staleEpoch)).status).toBe(404);

    const oldRing = createKeyRing();
    const oldToken = grant(oldRing);
    const nextKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotatingRing: PreviewKeyRing = {
      activeKeyId: "test-next",
      privateKey: nextKeys.privateKey,
      publicKeys: new Map([...oldRing.publicKeys, ["test-next", nextKeys.publicKey]]),
    };
    const publicKeyMap = Object.fromEntries([...rotatingRing.publicKeys].map(([id, key]) => [
      id,
      key.export({ format: "der", type: "spki" }).toString("base64"),
    ]));
    const publicOnlyKeyRing = loadPreviewVerifierKeyRing(JSON.stringify(publicKeyMap));
    expect(publicOnlyKeyRing).toBeDefined();
    expect(publicOnlyKeyRing).not.toHaveProperty("privateKey");
    expect(verifyPreviewGrant(oldToken, publicOnlyKeyRing!).userId).toBe(ownerA);
  });

  it("sirve HTML/assets solo a owner, deniega host/path hostiles y filtra credenciales upstream", async () => {
    const session = await exchange();
    const cookie = String(session.headers["set-cookie"]).split(";")[0] ?? "";
    const page = await request(gatewayPort, "/index.html", {
      host: hostA,
      cookie: `${cookie}; clerk_session=must-not-forward`,
      authorization: "Bearer platform-secret",
      "x-clerk-auth": "must-not-forward",
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("my private game");
    expect(page.headers["cache-control"]).toBe("private, no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(page.headers["content-security-policy"]).toContain(`frame-ancestors ${appOrigin}`);
    expect(page.headers["content-security-policy"]).not.toContain("default-src *");
    expect(page.headers["content-security-policy"]).toContain(`connect-src 'self' wss://${hostA}`);
    expect(page.headers["permissions-policy"]).toContain("camera=()");
    expect(page.headers["permissions-policy"]).toContain("microphone=()");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(backendRequests.at(-1)).toMatchObject({ path: "/__preview/index.html", previewOrigin: `https://${hostA}` });
    expect(backendRequests.at(-1)?.cookie).toBeUndefined();
    expect(backendRequests.at(-1)?.authorization).toBeUndefined();
    expect(backendRequests.at(-1)?.clerk).toBeUndefined();

    const asset = await request(gatewayPort, "/assets/game.js", { host: hostA, cookie });
    expect(asset.status).toBe(200);
    expect(asset.body).toContain("privateGame");
    const missingForOwner = await request(gatewayPort, "/missing.js", { host: hostA, cookie });
    const missingForAnonymous = await request(gatewayPort, "/missing.js", { host: hostA });
    expect(missingForOwner.status).toBe(404);
    expect(missingForOwner.body).toBe("upstream detail");
    expect(missingForAnonymous.body).toBe("Preview unavailable\n");

    const anonymous = await request(gatewayPort, "/index.html", { host: hostA });
    const spoofedHost = await request(gatewayPort, "/index.html", { host: `attacker.${baseDomain}`, cookie });
    const traversal = await request(gatewayPort, "/%2e%2e/private", { host: hostA, cookie });
    expect(anonymous.status).toBe(404);
    expect(spoofedHost.status).toBe(404);
    expect(traversal.status).toBe(404);
    expect(anonymous.body).toBe(spoofedHost.body);
    expect(anonymous.body).toBe(traversal.body);
    expect(backendRequests).toHaveLength(3);
  });

  it("deniega el mismo HMR a B/anónimo y cierra HTTP/WebSocket al expirar la sesión", async () => {
    const ownerASession = await exchange();
    const cookieA = String(ownerASession.headers["set-cookie"]).split(";")[0] ?? "";
    const ownerBSession = await exchange(grant(keyRing, projectB, ownerB), `${projectB}.${baseDomain}`);
    const cookieB = String(ownerBSession.headers["set-cookie"]).split(";")[0] ?? "";
    const allowedAsset = await request(gatewayPort, "/@vite/client", { host: hostA, cookie: cookieA });
    const deniedToB = await request(gatewayPort, "/@vite/client", { host: hostA, cookie: cookieB });
    const deniedToAnonymous = await request(gatewayPort, "/@vite/client", { host: hostA });
    expect(allowedAsset.status).toBe(200);
    expect(deniedToB.status).toBe(deniedToAnonymous.status);
    expect(deniedToB.body).toBe(deniedToAnonymous.body);
    expect(backendRequests.filter((entry) => entry.path === "/__preview/@vite/client")).toHaveLength(1);

    await gateway.close();
    gateway = createPreviewGateway({
      baseDomain,
      appOrigin,
      sessionTtlSeconds: 1,
      store,
      keyRing,
      resolveTarget: async (projectId) => projectId === projectA ? target() : undefined,
      proxyAddress: () => ({ hostname: "127.0.0.1", port: backendPort }),
    });
    await gateway.start(0, "127.0.0.1");
    const address = gateway.server.address();
    if (!address || typeof address === "string") throw new Error("gateway_address_missing");
    gatewayPort = address.port;
    const shortSession = await exchange();
    const shortCookie = String(shortSession.headers["set-cookie"]).split(";")[0] ?? "";
    const socket = createConnection({ host: "127.0.0.1", port: gatewayPort });
    activeBrowserSocket = socket;
    socket.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const key = randomBase64Key();
    socket.write([
      "GET /@vite/client HTTP/1.1",
      `Host: ${hostA}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      `Origin: https://${hostA}`,
      `Cookie: ${shortCookie}`,
      "\r\n",
    ].join("\r\n"));
    const handshake = await readRawUntil(socket, Buffer.from("\r\n\r\n"));
    expect(handshake.toString("utf8")).toContain("101 Switching Protocols");
    const closeFrame = await readRawUntil(socket, Buffer.from([0x88, 0x02, 0x03, 0xf0]));
    expect(closeFrame.includes(Buffer.from([0x88, 0x02, 0x03, 0xf0]))).toBe(true);
    const afterExpiry = await request(gatewayPort, "/index.html", { host: hostA, cookie: shortCookie });
    expect(afterExpiry.status).toBe(404);
    socket.destroy();
  });

  it("cierra el WebSocket al revocar la sesión y no reenvía cookies/identidad al juego", async () => {
    const session = await exchange();
    const cookie = String(session.headers["set-cookie"]).split(";")[0] ?? "";
    const socket = createConnection({ host: "127.0.0.1", port: gatewayPort });
    activeBrowserSocket = socket;
    socket.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const key = randomBase64Key();
    socket.write([
      "GET /@vite/client?session=private HTTP/1.1",
      `Host: ${hostA}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      `Origin: https://${hostA}`,
      `Cookie: ${cookie}; clerk_session=private`,
      "Authorization: Bearer secret",
      "X-Clerk-Auth: secret",
      "\r\n",
    ].join("\r\n"));
    const handshake = await readRawUntil(socket, Buffer.from("\r\n\r\n"));
    expect(handshake.toString("utf8")).toContain("101 Switching Protocols");
    expect(handshake.toString("utf8")).not.toContain("Set-Cookie");
    expect(backendRequests.at(-1)).toMatchObject({ path: "/__preview/@vite/client?session=private", origin: `https://${hostA}` });
    expect(backendRequests.at(-1)?.cookie).toBeUndefined();
    expect(backendRequests.at(-1)?.authorization).toBeUndefined();
    expect(backendRequests.at(-1)?.clerk).toBeUndefined();

    await store.revokeProject(projectA);
    const closeFrame = await readRawUntil(socket, Buffer.from([0x88, 0x02, 0x03, 0xf0]));
    expect(closeFrame.includes(Buffer.from([0x88, 0x02, 0x03, 0xf0]))).toBe(true);
    socket.destroy();
  });

  it("emite grants solo tras same-origin y ownership verificado", async () => {
    const handlers = createPreviewGrantHandlers({
      authenticator: { requireUser: async () => ({ clerkUserId: ownerA } as never) },
      projects: { get: async (identity) => identity.clerkUserId === ownerA ? { id: projectA } : undefined },
      target: async (projectId) => projectId === projectA ? { projectId, ownerClerkUserId: ownerA, sandboxId: sandboxA } : undefined,
      store,
      keyRing,
      allowedOrigins: [appOrigin],
      baseDomain,
    });
    const context = { params: Promise.resolve({ projectId: projectA }) };
    const forbidden = await handlers.POST(new Request(`${appOrigin}/api/projects/${projectA}/preview-grant`, {
      method: "POST", headers: { origin: "https://attacker.example" },
    }), context);
    expect(forbidden.status).toBe(403);

    const response = await handlers.POST(new Request(`${appOrigin}/api/projects/${projectA}/preview-grant`, {
      method: "POST", headers: { origin: appOrigin },
    }), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as { grant: string; previewUrl: string; expiresAt: string };
    expect(payload.previewUrl).toBe(`https://${hostA}/`);
    expect(payload.previewUrl).not.toContain("grant=");
    expect(new URL(payload.previewUrl).search).toBe("");
    expect(payload.grant.split(".")).toHaveLength(3);

    const revoke = await handlers.DELETE(new Request(`${appOrigin}/api/projects/${projectA}/preview-grant`, {
      method: "DELETE", headers: { origin: appOrigin },
    }), context);
    expect(revoke.status).toBe(204);
    expect(await store.getProjectEpoch(projectA)).toBe(1);

    const ownerBHandlers = createPreviewGrantHandlers({
      authenticator: { requireUser: async () => ({ clerkUserId: ownerB } as never) },
      projects: { get: async () => undefined },
      target: async () => target(),
      store,
      keyRing,
      allowedOrigins: [appOrigin],
      baseDomain,
    });
    const crossOwner = await ownerBHandlers.POST(new Request(`${appOrigin}/api/projects/${projectA}/preview-grant`, {
      method: "POST", headers: { origin: appOrigin },
    }), context);
    expect(crossOwner.status).toBe(404);
    expect(await crossOwner.json()).toEqual({ error: "not_found" });
  });
});

function randomBase64Key(): string {
  return randomBytes(16).toString("base64");
}
