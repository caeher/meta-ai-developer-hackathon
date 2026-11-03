import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SandboxBusyError, SandboxNotFoundError, SandboxService } from "./service";
import { SandboxRuntimeError } from "./driver";
import { createTelemetryLogger, isOpaqueTelemetryId, withTelemetryContext, type TelemetryMetrics } from "@meta-game/config";
import {
  SandboxInstallDependenciesInputSchema,
  SandboxReadFileInputSchema,
  SandboxReadBinaryFileInputSchema,
  SandboxDeleteFileInputSchema,
  SandboxRunCommandInputSchema,
  SandboxWriteFileInputSchema,
  SandboxWriteBinaryFileInputSchema,
  GameBrowserVerificationInputSchema,
} from "@meta-game/contracts";

const projectPath = /^\/v1\/projects\/([0-9a-f-]{36})\/sandbox$/i;
const execPath = /^\/v1\/projects\/([0-9a-f-]{36})\/sandbox\/exec$/i;
const stopPath = /^\/v1\/projects\/([0-9a-f-]{36})\/sandbox\/stop$/i;
const cleanupPath = /^\/v1\/projects\/([0-9a-f-]{36})\/sandbox\/cleanup$/i;
const quiescePath = /^\/v1\/projects\/([0-9a-f-]{36})\/sandbox\/quiesce$/i;
const toolPath = /^\/v1\/projects\/([0-9a-f-]{36})\/sandbox\/tools\/(read-file|read-binary-file|write-file|delete-file|write-binary-file|list-files|install-dependencies|run-command|start-dev-server|read-logs|verify-game)$/i;
const projectIdSchema = z.uuid();
const execSchema = z.object({
  argv: z.array(z.string()).min(1).max(64),
  cwd: z.string().max(512).default(""),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
}).strict();

export function createSandboxControllerServer(service: SandboxService, token: string, metrics?: TelemetryMetrics): Server {
  if (Buffer.byteLength(token) < 32 || /placeholder|replace-me|change-me/i.test(token)) {
    throw new Error("SANDBOX_CONTROLLER_TOKEN must be a generated secret");
  }
  const server = createServer((request, response) => {
    const logger = createTelemetryLogger("sandbox-controller");
    const started = Date.now();
    response.once("finish", () => {
      const method = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).has(request.method ?? "") ? request.method! : "OTHER";
      const statusClass = String(Math.floor(response.statusCode / 100)) + "xx";
      metrics?.increment("http_requests_total", { method, status_class: statusClass });
      metrics?.observe("http_request_duration_seconds", Math.max(0, Date.now() - started) / 1_000, { method });
    });
    const runHeader = request.headers["x-run-id"];
    const runId = typeof runHeader === "string" && isOpaqueTelemetryId(runHeader) ? runHeader : undefined;
    void withTelemetryContext(runId ? { runId } : {}, () => handleRequest(request, response, service, token, metrics, logger));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: SandboxService,
  token: string,
  metrics?: TelemetryMetrics,
  logger?: ReturnType<typeof createTelemetryLogger>,
): Promise<void> {
  setSecurityHeaders(response);
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, 200, { status: "ready" });
    return;
  }
  if (!validBearer(request.headers.authorization, token)) {
    metrics?.increment("sandbox_operations_total", { operation: "exec", outcome: "denied" });
    logger?.warn("sandbox.request_denied", { operation: "exec", outcome: "denied" });
    send(response, 401, { error: "unauthorized" });
    return;
  }
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const match = projectPath.exec(pathname) ?? execPath.exec(pathname) ?? stopPath.exec(pathname) ?? cleanupPath.exec(pathname) ?? quiescePath.exec(pathname) ?? toolPath.exec(pathname);
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
  const pathTool = toolPath.exec(pathname)?.[2];
  const operation = pathTool === "read-file" || pathTool === "read-binary-file" || pathTool === "read-logs" ? "read"
    : pathTool === "write-file" || pathTool === "write-binary-file" ? "write"
      : pathTool === "delete-file" ? "delete"
      : pathTool === "list-files" ? "list"
        : pathTool === "install-dependencies" ? "install"
          : pathTool === "run-command" || execPath.test(pathname) ? "exec"
            : pathTool === "verify-game" ? "verify"
              : pathTool === "start-dev-server" ? "start_server"
                : cleanupPath.test(pathname) || quiescePath.test(pathname) ? "cleanup"
                  : request.method === "DELETE" ? "delete"
                    : request.method === "GET" ? "inspect" : stopPath.test(pathname) ? "stop" : "create";
  const recordOperation = (outcome: "success" | "error" | "denied") => {
    metrics?.increment("sandbox_operations_total", { operation, outcome });
    if (outcome === "success") logger?.info("sandbox.operation_completed", { operation, outcome });
    else logger?.error("sandbox.operation_failed", { operation, outcome, errorCode: "sandbox_operation_failed" });
  };
  try {
    if (request.method === "POST" && projectPath.test(pathname)) {
      const result = await service.create(projectId);
      recordOperation("success");
      send(response, 200, result);
      return;
    }
    if (request.method === "GET" && projectPath.test(pathname)) {
      const result = await service.inspect(projectId);
      recordOperation("success");
      send(response, 200, result);
      return;
    }
    if (request.method === "DELETE" && projectPath.test(pathname)) {
      const result = await service.destroy(projectId);
      recordOperation("success");
      send(response, 200, result);
      return;
    }
    if (request.method === "POST" && stopPath.test(pathname)) {
      const result = await service.stop(projectId);
      recordOperation("success");
      send(response, 200, result);
      return;
    }
    if (request.method === "POST" && cleanupPath.test(pathname)) {
      await service.cleanupManagedProject(projectId);
      recordOperation("success");
      send(response, 200, { cleaned: true });
      return;
    }
    if (request.method === "POST" && quiescePath.test(pathname)) {
      await service.quiesceManagedProject(projectId);
      recordOperation("success");
      send(response, 200, { quiesced: true });
      return;
    }
    if (request.method === "POST" && execPath.test(pathname)) {
      const body = await readJson(request);
      const input = execSchema.safeParse(body);
      if (!input.success) {
        send(response, 400, { error: "invalid_request" });
        return;
      }
      const result = await service.exec(projectId, input.data.argv, input.data.cwd, input.data.timeoutMs);
      recordOperation("success");
      send(response, 200, result);
      return;
    }
    const tool = toolPath.exec(pathname)?.[2];
    if (tool === "read-logs" && request.method === "GET") {
      const result = await service.readLogs(projectId);
      recordOperation("success");
      send(response, 200, result);
      return;
    }
    if (tool === "start-dev-server" && request.method === "POST") {
      const result = await service.startDevServer(projectId);
      metrics?.increment("sandbox_operations_total", { operation: "start_server", outcome: "success" });
      send(response, 200, result);
      return;
    }
    if (tool && request.method === "POST") {
      const body = await readJson(request, tool === "write-binary-file" ? 12 * 1024 * 1024 : 6_300_000);
      if (tool === "read-file") {
        const input = SandboxReadFileInputSchema.safeParse(body);
        if (!input.success) { send(response, 400, { error: "invalid_tool_input" }); return; }
        const result = await service.readFile(projectId, input.data.path);
        recordOperation("success");
        send(response, 200, result);
        return;
      }
      if (tool === "read-binary-file") {
        const input = SandboxReadBinaryFileInputSchema.safeParse(body);
        if (!input.success) { send(response, 400, { error: "invalid_tool_input" }); return; }
        const result = await service.readBinaryFile(projectId, input.data.path);
        recordOperation("success");
        send(response, 200, result);
        return;
      }
      if (tool === "write-file") {
        const input = SandboxWriteFileInputSchema.safeParse(body);
        if (!input.success) { send(response, 400, { error: "invalid_tool_input" }); return; }
        const result = await service.writeFile(projectId, input.data.path, input.data.content);
        recordOperation("success");
        send(response, 200, result);
        return;
      }
      if (tool === "delete-file") {
        const input = SandboxDeleteFileInputSchema.safeParse(body);
        if (!input.success) { send(response, 400, { error: "invalid_tool_input" }); return; }
        const result = await service.deleteFile(projectId, input.data.path);
        recordOperation("success");
        send(response, 200, result);
        return;
      }
      if (tool === "write-binary-file") {
        const input = SandboxWriteBinaryFileInputSchema.safeParse(body);
        if (!input.success) { send(response, 400, { error: "invalid_tool_input" }); return; }
        const bytes = Buffer.from(input.data.contentBase64, "base64");
        if (bytes.toString("base64") !== input.data.contentBase64) { send(response, 400, { error: "invalid_tool_input" }); return; }
        const result = await service.writeBinaryFile(projectId, input.data.path, bytes);
        recordOperation("success");
        send(response, 200, result);
        return;
      }
      if (tool === "list-files") {
        const input = z.object({ path: z.string().max(512).default("") }).strict().safeParse(body);
        if (!input.success) { send(response, 400, { error: "invalid_tool_input" }); return; }
        const result = await service.listFiles(projectId, input.data.path);
        recordOperation("success");
        send(response, 200, result);
        return;
      }
      if (tool === "install-dependencies") {
        const input = SandboxInstallDependenciesInputSchema.safeParse(body);
        if (!input.success) { send(response, 400, { error: "invalid_dependency_specification" }); return; }
        const result = await service.installDependencies(projectId, input.data);
        recordOperation("success");
        send(response, 200, result);
        return;
      }
      if (tool === "run-command") {
        const input = SandboxRunCommandInputSchema.safeParse(body);
        if (!input.success) { send(response, 400, { error: "invalid_tool_input" }); return; }
        const result = await service.runCommand(projectId, input.data);
        recordOperation("success");
        send(response, 200, result);
        return;
      }
      if (tool === "verify-game") {
        const input = GameBrowserVerificationInputSchema.safeParse(body);
        if (!input.success) { send(response, 400, { error: "invalid_tool_input" }); return; }
        const result = await service.verifyGameInteraction(projectId, input.data);
        recordOperation("success");
        send(response, 200, result);
        return;
      }
    }
    send(response, 405, { error: "method_not_allowed" });
  } catch (error) {
    recordOperation("error");
    if (error instanceof SandboxNotFoundError || (error instanceof Error && error.name === "SandboxProjectNotFoundError")) {
      send(response, 404, { error: "not_found" });
    } else if (error instanceof SandboxBusyError || (error instanceof Error && error.name === "SandboxOperationConflictError")) {
      send(response, 409, { error: "sandbox_busy" });
    } else if (error instanceof SandboxRuntimeError) {
      const status = ["sandbox_not_running", "execution_timeout", "sandbox_busy"].includes(error.code) ? 409 :
        ["request_too_large", "file_too_large"].includes(error.code) ? 413 :
            ["invalid_json", "invalid_path", "invalid_tool_input", "invalid_dependency_specification", "dependency_not_approved", "sandbox_command_not_allowed"].includes(error.code) ? 400 :
            ["file_not_found", "path_not_found"].includes(error.code) ? 404 : 503;
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

async function readJson(request: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
    throw new SandboxRuntimeError("request_too_large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > maxBytes) throw new SandboxRuntimeError("request_too_large");
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
