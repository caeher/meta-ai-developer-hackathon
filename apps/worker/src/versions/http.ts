import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { identityFromAuthenticatedSession } from "@meta-game/db";
import { z } from "zod";

const restorePath = /^\/internal\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})\/restore$/i;
const restoreInput = z.object({ clerkUserId: z.string().trim().min(1).max(255) }).strict();

export function createWorkerVersionServer(options: {
  token: string;
  restore(identity: ReturnType<typeof identityFromAuthenticatedSession>, projectId: string, versionId: string): Promise<unknown>;
}): Server {
  if (Buffer.byteLength(options.token) < 32 || /placeholder|replace-me|change-me/i.test(options.token)) {
    throw new Error("WORKER_INTERNAL_TOKEN must be a generated secret");
  }
  const server = createServer((request, response) => { void handle(request, response, options); });
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
  securityHeaders(response);
  if (request.method !== "POST" || !request.url) { send(response, 405, { error: "method_not_allowed" }); return; }
  if (!validBearer(request.headers.authorization, options.token)) { send(response, 401, { error: "unauthorized" }); return; }
  const match = restorePath.exec(new URL(request.url, "http://worker.internal").pathname);
  if (!match) { send(response, 404, { error: "not_found" }); return; }
  try {
    const body = await readJson(request, 4_096);
    const input = restoreInput.safeParse(body);
    if (!input.success) { send(response, 400, { error: "invalid_request" }); return; }
    const identity = identityFromAuthenticatedSession({ userId: input.data.clerkUserId });
    const result = await options.restore(identity, match[1]!, match[2]!);
    if (!result) { send(response, 404, { error: "not_found" }); return; }
    send(response, 200, { restored: result });
  } catch (error) {
    if (error instanceof Error && error.name === "ProjectRunBusyError") {
      send(response, 409, { error: "project_busy" });
      return;
    }
    send(response, 503, { error: "restore_failed" });
  }
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
