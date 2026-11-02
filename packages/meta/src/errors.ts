import {
  MetaErrorDetailsSchema,
  type MetaErrorCode,
  type MetaErrorDetails,
} from "@meta-game/contracts";

export class MetaApiError extends Error {
  readonly code: MetaErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly ambiguous: boolean;

  constructor(args: {
    code: MetaErrorCode;
    message: string;
    status?: number;
    requestId?: string;
    retryAfterMs?: number;
    ambiguous?: boolean;
  }) {
    super(args.message);
    this.name = "MetaApiError";
    this.code = args.code;
    this.status = args.status;
    this.requestId = args.requestId;
    this.retryAfterMs = args.retryAfterMs;
    this.ambiguous = args.ambiguous ?? false;
  }

  toDetails(): MetaErrorDetails {
    return MetaErrorDetailsSchema.parse({
      code: this.code,
      status: this.status,
      requestId: this.requestId,
      retryAfterMs: this.retryAfterMs,
      ambiguous: this.ambiguous,
    });
  }
}

export function classifyHttpStatus(status: number, path?: string): MetaErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 404 && path === "/responses") return "model_unavailable";
  if ([400, 413, 422].includes(status)) return "invalid_request";
  if (status >= 500) return "provider_error";
  return "http_error";
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(120_000, Math.ceil(seconds * 1_000));
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.min(120_000, Math.max(0, dateMs - now));
}
