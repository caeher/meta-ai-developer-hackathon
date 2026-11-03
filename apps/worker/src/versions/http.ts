import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { identityFromAuthenticatedSession } from "@meta-game/db";
import { createTelemetryLogger, isOpaqueTelemetryId, withTelemetryContext } from "@meta-game/config";
import { z } from "zod";

const restorePath = /^\/internal\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})\/restore$/i;
const publishPath = /^\/internal\/projects\/([0-9a-f-]{36})\/publications$/i;
const revokePath = /^\/internal\/projects\/([0-9a-f-]{36})\/publications\/([0-9a-f-]{36})$/i;
const restoreInput = z.object({ userId: z.string().trim().min(1).max(255) }).strict();
const publishInput = restoreInput.extend({
  versionId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict();

export function createWorkerVersionServer(options: {
  token: string;
  restore?(identity: ReturnType<typeof identityFromAuthenticatedSession>, projectId: string, versionId: string): Promise<unknown>;
  publish?(identity: ReturnType<typeof identityFromAuthenticatedSession>, projectId: string, versionId: string, idempotencyKey: string): Promise<unknown>;
  revoke?(identity: ReturnType<typeof identityFromAuthenticatedSession>, projectId: string, publicationId: string): Promise<unknown>;
}): Server {
  if (Buffer.byteLength(options.token) < 32 || /placeholder|replace-me|change-me/i.test(options.token)) {
    throw new Error("WORKER_INTERNAL_TOKEN must be a generated secret");
  }
  const server = createServer((request, response) => {
    const value = request.headers["x-request-id"];
    const requestId = typeof value === "string" && isOpaqueTelemetryId(value) ? value : undefined;
    void withTelemetryContext(requestId ? { requestId } : {}, () => handle(request, response, options));
  });
  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: Parameters<typeof createWorkerVersionServer>[0],
) {
  const logger = createTelemetryLogger("worker");
  securityHeaders(response);
  if (!request.url || !["POST", "DELETE"].includes(request.method ?? "")) { send(response, 405, { error: "method_not_allowed" }); return; }
  if (!validBearer(request.headers.authorization, options.token)) { send(response, 401, { error: "unauthorized" }); return; }
  const pathname = new URL(request.url, "http://worker.internal").pathname;
  const restore = request.method === "POST" ? restorePath.exec(pathname) : null;
  const publish = request.method === "POST" ? publishPath.exec(pathname) : null;
  const revoke = request.method === "DELETE" ? revokePath.exec(pathname) : null;
  if (!restore && !publish && !revoke) { send(response, 404, { error: "not_found" }); return; }
  try {
    const body = request.method === "DELETE" ? await readJson(request, 4_096) : await readJson(request, 4_096);
    const input = (publish ? publishInput : restoreInput).safeParse(body);
    if (!input.success) { send(response, 400, { error: "invalid_request" }); return; }
    const identity = identityFromAuthenticatedSession({ userId: input.data.userId });
    let result: unknown;
    if (restore) {
      if (!options.restore) { send(response, 503, { error: "restore_unavailable" }); return; }
      result = await options.restore(identity, restore[1]!, restore[2]!);
    } else if (publish) {
      if (!options.publish || !publishInput.safeParse(body).success) { send(response, 503, { error: "publishing_unavailable" }); return; }
      const publishBody = publishInput.parse(body);
      result = await options.publish(identity, publish[1]!, publishBody.versionId, publishBody.idempotencyKey);
    } else if (revoke) {
      if (!options.revoke) { send(response, 503, { error: "publishing_unavailable" }); return; }
      result = await options.revoke(identity, revoke[1]!, revoke[2]!);
    }
    if (!result) { send(response, 404, { error: "not_found" }); return; }
    if (restore) {
      logger.info("version.restore_completed", { operation: "restore", outcome: "success" });
      send(response, 200, { restored: result });
    } else if (publish) {
      logger.info("publication.build_started", { operation: "publish", outcome: "success" });
      send(response, 202, { publication: publicPublication(result) });
    } else {
      logger.info("publication.revoked", { operation: "revoke", outcome: "success" });
      send(response, 200, { publication: publicPublication(result) });
    }
  } catch (error) {
    logger.error("internal.operation_failed", { operation: restore ? "restore" : "publish", outcome: "failed", errorCode: "worker_internal_operation_failed" });
    if (error instanceof Error && error.name === "ProjectRunBusyError") {
      send(response, 409, { error: "project_busy" });
      return;
    }
    if (error instanceof Error && error.name === "IdempotencyConflictError") { send(response, 409, { error: "idempotency_conflict" }); return; }
    send(response, 503, { error: restore ? "restore_failed" : "publishing_failed" });
  }
}

function publicPublication(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const publication = value as Record<string, unknown>;
  return {
    id: publication.id,
    projectId: publication.projectId,
    versionId: publication.versionId,
    slug: publication.slug,
    status: publication.status,
    idempotencyKey: publication.idempotencyKey,
    artifactSha256: publication.artifactSha256,
    manifest: publication.manifest,
    createdAt: publication.createdAt,
    updatedAt: publication.updatedAt,
  };
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maxBytes) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown; }
  catch { throw new Error("invalid_json"); }
}

function validBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const key = Buffer.from(expected);
  return provided.length === key.length && timingSafeEqual(provided, key);
}

function securityHeaders(response: ServerResponse) {
  response.setHeader("cache-control", "private, no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-type", "application/json; charset=utf-8");
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.end(JSON.stringify(value));
}
