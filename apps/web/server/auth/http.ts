import { IdempotencyConflictError, OwnedResourceNotFoundError } from "@meta-game/db";
import { ZodError } from "zod";
import { AuthenticationRequiredError } from "./guards";

export class OriginValidationError extends Error {
  constructor() {
    super("Origen de solicitud no permitido");
    this.name = "OriginValidationError";
  }
}

export async function readLimitedJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new TypeError("Se requiere application/json");
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) throw new TypeError("Solicitud demasiado grande");
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError("Se requiere un body JSON");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new TypeError("Solicitud demasiado grande");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

export function assertSameOriginRequest(request: Request, allowedOrigins: readonly string[]): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    !origin ||
    !allowedOrigins.includes(origin) ||
    (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "same-site")
  ) {
    throw new OriginValidationError();
  }
}

export function apiErrorResponse(error: unknown): Response {
  let status = 500;
  let code = "internal_error";
  if (error instanceof AuthenticationRequiredError) {
    status = 401;
    code = "unauthenticated";
  } else if (error instanceof OwnedResourceNotFoundError) {
    status = 404;
    code = "not_found";
  } else if (error instanceof IdempotencyConflictError) {
    status = 409;
    code = "idempotency_conflict";
  } else if (error instanceof OriginValidationError) {
    status = 403;
    code = "origin_not_allowed";
  } else if (error instanceof ZodError || error instanceof SyntaxError || error instanceof TypeError) {
    status = 400;
    code = "invalid_request";
  }

  return Response.json(
    { error: code },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
