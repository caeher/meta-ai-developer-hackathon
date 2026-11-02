import { OwnedResourceNotFoundError } from "@meta-game/db";
import { ZodError } from "zod";
import { AuthenticationRequiredError } from "./guards";

export class OriginValidationError extends Error {
  constructor() {
    super("Origen de solicitud no permitido");
    this.name = "OriginValidationError";
  }
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
