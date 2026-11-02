import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SandboxBusyError, SandboxNotFoundError, SandboxService } from "./service";
import { SandboxRuntimeError } from "./driver";

const projectPath = /^\/v1\/projects\/([0-9a-f-]{36})\/sandbox$/i;
const execPath = /^\/v1\/projects\/([0-9a-f-]{36})\/sandbox\/exec$/i;
const stopPath = /^\/v1\/projects\/([0-9a-f-]{36})\/sandbox\/stop$/i;
const projectIdSchema = z.uuid();
const execSchema = z.object({
  argv: z.array(z.string()).min(1).max(64),
  cwd: z.string().max(512).default(""),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
}).strict();

export function createSandboxControllerServer(service: SandboxService, token: string): Server {
  if (Buffer.byteLength(token) < 32 || /placeholder|replace-me|change-me/i.test(token)) {
    throw new Error("SANDBOX_CONTROLLER_TOKEN must be a generated secret");
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, service, token);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, service: SandboxService, token: string): Promise<void> {
  setSecurityHeaders(response);
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, 200, { status: "ready" });
    return;
  }
  if (!validBearer(request.headers.authorization, token)) {
    send(response, 401, { error: "unauthorized" });
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const match = projectPath.exec(pathname) ?? execPath.exec(pathname) ?? stopPath.exec(pathname);
  if (!match) {
    send(response, 404, { error: "not_found" });
    return;
  }
  const parsedId = projectIdSchema.safeParse(match[1]);
  if (!parsedId.success) {
    send(response, 404, { error: "not_found" });
    return;
  }
  const projectId = parsedId.data;
  try {
    if (request.method === "POST" && projectPath.test(pathname)) {
      send(response, 200, await service.create(projectId));
      return;
    }
    if (request.method === "GET" && projectPath.test(pathname)) {
      send(response, 200, await service.inspect(projectId));
      return;
    }
    if (request.method === "DELETE" && projectPath.test(pathname)) {
      send(response, 200, await service.destroy(projectId));
      return;
    }
    if (request.method === "POST" && stopPath.test(pathname)) {
      send(response, 200, await service.stop(projectId));
      return;
    }
    if (request.method === "POST" && execPath.test(pathname)) {
      const body = await readJson(request);
      const input = execSchema.safeParse(body);
      if (!input.success) {
        send(response, 400, { error: "invalid_request" });
        return;
      }
      send(response, 200, await service.exec(projectId, input.data.argv, input.data.cwd, input.data.timeoutMs));
      return;
    }
    send(response, 405, { error: "method_not_allowed" });
  } catch (error) {
    if (error instanceof SandboxNotFoundError || (error instanceof Error && error.name === "SandboxProjectNotFoundError")) {
      send(response, 404, { error: "not_found" });
    } else if (error instanceof SandboxBusyError || (error instanceof Error && error.name === "SandboxOperationConflictError")) {
      send(response, 409, { error: "sandbox_busy" });
    } else if (error instanceof SandboxRuntimeError) {
      const status = ["sandbox_not_running", "execution_timeout"].includes(error.code) ? 409 :
        error.code === "request_too_large" ? 413 : error.code === "invalid_json" ? 400 : 503;
      send(response, status, { error: error.code });
    } else {
      send(response, 500, { error: "sandbox_controller_failed" });
    }
  }
}

function validBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > 16_384) {
    throw new SandboxRuntimeError("request_too_large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > 16_384) throw new SandboxRuntimeError("request_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
  catch { throw new SandboxRuntimeError("invalid_json"); }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.statusCode = status;
  response.end(JSON.stringify(body));
}
