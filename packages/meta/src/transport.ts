import { z } from "zod";
import type { MetaConfig } from "./config.js";

const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })),
});

const ResponseSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  model: z.string().min(1),
  status: z.string().min(1),
  output: z.array(z.record(z.string(), z.unknown())),
  output_text: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).passthrough().nullable().optional(),
});

export type MetaResponse = z.infer<typeof ResponseSchema>;
export type MetaResponsePayload = {
  model: string;
  input: string | Array<Record<string, unknown>>;
  store: false;
  max_output_tokens?: number;
  reasoning?: { effort: "low" };
  tools?: Array<Record<string, unknown>>;
  tool_choice?: "auto";
};

export class MetaApiError extends Error {
  readonly code: "http_error" | "timeout" | "network_error" | "invalid_json" | "invalid_schema";
  readonly status?: number;
  readonly requestId?: string;

  constructor(args: {
    code: MetaApiError["code"];
    message: string;
    status?: number;
    requestId?: string;
  }) {
    super(args.message);
    this.name = "MetaApiError";
    this.code = args.code;
    this.status = args.status;
    this.requestId = args.requestId;
  }
}

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

export class MetaTransport {
  constructor(
    private readonly config: MetaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listModels(): Promise<{ ids: string[]; requestId?: string }> {
    const result = await this.requestJson("GET", "/models");
    const parsed = ModelListSchema.safeParse(result.body);
    if (!parsed.success) {
      throw new MetaApiError({ code: "invalid_schema", message: "Meta API returned an invalid model list." });
    }

    return { ids: parsed.data.data.map((model) => model.id), requestId: result.requestId };
  }

  async createResponse(payload: MetaResponsePayload): Promise<{ response: MetaResponse; requestId?: string }> {
    const result = await this.requestJson("POST", "/responses", payload);
    const parsed = ResponseSchema.safeParse(result.body);
    if (!parsed.success) {
      throw new MetaApiError({
        code: "invalid_schema",
        message: "Meta API returned an invalid Responses API payload.",
        requestId: result.requestId,
      });
    }

    return { response: parsed.data, requestId: result.requestId };
  }

  private async requestJson(
    method: "GET" | "POST",
    path: "/models" | "/responses",
    payload?: MetaResponsePayload,
  ): Promise<{ body: unknown; requestId?: string }> {
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal,
        redirect: "error",
      });
    } catch (error) {
      const timedOut = signal.aborted || (error instanceof DOMException && error.name === "TimeoutError");
      throw new MetaApiError({
        code: timedOut ? "timeout" : "network_error",
        message: timedOut ? `Meta API ${method} ${path} timed out.` : `Meta API ${method} ${path} could not be reached.`,
      });
    }

    const requestId = safeRequestId(response.headers.get("x-request-id"));
    if (!response.ok) {
      throw new MetaApiError({
        code: "http_error",
        status: response.status,
        requestId,
        message: `Meta API returned HTTP ${response.status} for ${method} ${path}.`,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "TimeoutError")) {
        throw new MetaApiError({ code: "timeout", message: `Meta API ${method} ${path} timed out.` });
      }
      throw new MetaApiError({
        code: "invalid_json",
        requestId,
        message: `Meta API returned invalid JSON for ${method} ${path}.`,
      });
    }

    return { body, requestId };
  }
}
