import "server-only";
import type { MetaConfig } from "./config.js";
import { z } from "zod";
import { classifyHttpStatus, MetaApiError, parseRetryAfter } from "./errors.js";
import { ProviderResponseSchema, type ProviderResponse, type ProviderResponsePayload } from "./responses.js";

const MAX_JSON_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_SAFE_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 5_000;

const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(128) })),
});

export interface MetaTransportOptions {
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
}

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function createOperationSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { signal: external ? AbortSignal.any([external, timeout]) : timeout, timeout };
}

function abortError(
  timeout: AbortSignal,
  external: AbortSignal | undefined,
  method: string,
  path: string,
  ambiguous = method === "POST",
): MetaApiError {
  if (external?.aborted) {
    return new MetaApiError({ code: "cancelled", message: `Meta API ${method} ${path} was cancelled.`, ambiguous });
  }
  if (timeout.aborted) {
    return new MetaApiError({ code: "timeout", message: `Meta API ${method} ${path} timed out.`, ambiguous });
  }
  return new MetaApiError({ code: "network_error", message: `Meta API ${method} ${path} could not be reached.`, ambiguous });
}

function readError(timeout: AbortSignal, external: AbortSignal | undefined, method: string, path: string, error: unknown): MetaApiError {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new MetaApiError({ code: "timeout", message: `Meta API ${method} ${path} timed out.`, ambiguous: method === "POST" });
  }
  return abortError(timeout, external, method, path);
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readLimitedBody(response: Response, limitBytes: number, onReadError: (error: unknown) => MetaApiError): Promise<string> {
  if (!response.body) {
    // Lightweight fake responses used by contract tests may only implement json().
    if (typeof response.json === "function") {
      try {
        const value: unknown = await response.json();
        const text = JSON.stringify(value);
        if (Buffer.byteLength(text, "utf8") > limitBytes) throw new Error("response size limit");
        return text;
      } catch (error) {
        throw onReadError(error);
      }
    }
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limitBytes) {
        await reader.cancel();
        throw new MetaApiError({ code: "invalid_response", message: "Meta API response exceeded the configured size limit." });
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } catch (error) {
    if (error instanceof MetaApiError) throw error;
    throw onReadError(error);
  } finally {
    reader.releaseLock();
  }
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class MetaTransport {
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly maxRetries: number;

  constructor(
    private readonly config: MetaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    options: MetaTransportOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.maxRetries = Math.max(0, Math.min(MAX_SAFE_RETRIES, options.maxRetries ?? MAX_SAFE_RETRIES));
  }

  async listModels(signal?: AbortSignal): Promise<{ ids: string[]; requestId?: string }> {
    const result = await this.requestJson("GET", "/models", undefined, signal, true);
    const parsed = ModelListSchema.safeParse(result.body);
    if (!parsed.success) {
      throw new MetaApiError({ code: "invalid_response", message: "Meta API returned an invalid model list.", requestId: result.requestId });
    }
    return { ids: parsed.data.data.map((model) => model.id), requestId: result.requestId };
  }

  async createResponse(
    payload: ProviderResponsePayload,
    signal?: AbortSignal,
  ): Promise<{ response: ProviderResponse; requestId?: string }> {
    const result = await this.requestJson("POST", "/responses", payload, signal, false);
    const parsed = ProviderResponseSchema.safeParse(result.body);
    if (!parsed.success) {
      throw new MetaApiError({ code: "invalid_response", message: "Meta API returned an invalid Responses API payload.", requestId: result.requestId, ambiguous: true });
    }
    return { response: parsed.data, requestId: result.requestId };
  }

  async openResponseStream(
    payload: ProviderResponsePayload,
    signal?: AbortSignal,
  ): Promise<{ events: AsyncIterable<Record<string, unknown>>; requestId?: string }> {
    const endpoint = "/responses";
    const operation = createOperationSignal(this.config.timeoutMs, signal);
    if (signal?.aborted) throw abortError(operation.timeout, signal, "POST", endpoint, false);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: operation.signal,
        redirect: "error",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new MetaApiError({ code: "timeout", message: "Meta API POST /responses timed out.", ambiguous: true });
      }
      throw abortError(operation.timeout, signal, "POST", endpoint);
    }

    const requestId = safeRequestId(response.headers.get("x-request-id"));
    if (!response.ok) {
      const status = response.status;
      throw new MetaApiError({
        code: classifyHttpStatus(status, endpoint),
        status,
        requestId,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        ambiguous: status >= 500,
        message: `Meta API returned HTTP ${status} for POST ${endpoint}.`,
      });
    }
    if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      throw new MetaApiError({ code: "invalid_response", message: "Meta API did not return a valid event stream.", requestId, ambiguous: true });
    }

    return {
      requestId,
      events: this.readSse(response.body, operation.timeout, signal, requestId),
    };
  }

  private async requestJson(
    method: "GET" | "POST",
    path: "/models" | "/responses",
    payload: ProviderResponsePayload | undefined,
    externalSignal: AbortSignal | undefined,
    retrySafe: boolean,
  ): Promise<{ body: unknown; requestId?: string }> {
    const operation = createOperationSignal(this.config.timeoutMs, externalSignal);
    let attempt = 0;

    while (true) {
      if (operation.signal.aborted) throw abortError(operation.timeout, externalSignal, method, path, false);
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
          signal: operation.signal,
          redirect: "error",
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new MetaApiError({ code: "timeout", message: `Meta API ${method} ${path} timed out.`, ambiguous: method === "POST" });
        }
        if (retrySafe && attempt < this.maxRetries && !operation.signal.aborted) {
          await this.waitBeforeRetry(undefined, attempt, operation.signal);
          attempt += 1;
          continue;
        }
        throw abortError(operation.timeout, externalSignal, method, path);
      }

      const requestId = safeRequestId(response.headers.get("x-request-id"));
      if (!response.ok) {
        const status = response.status;
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        if (retrySafe && retryableStatus(status) && attempt < this.maxRetries && !operation.signal.aborted) {
          const retried = await this.waitBeforeRetry(retryAfterMs, attempt, operation.signal);
          if (retried) {
            attempt += 1;
            continue;
          }
          if (operation.signal.aborted) throw abortError(operation.timeout, externalSignal, method, path);
        }
        throw new MetaApiError({
          code: classifyHttpStatus(status, path),
          status,
          requestId,
          retryAfterMs,
          ambiguous: method === "POST" && status >= 500,
          message: `Meta API returned HTTP ${status} for ${method} ${path}.`,
        });
      }

      let text: string;
      try {
        text = await readLimitedBody(response, MAX_JSON_RESPONSE_BYTES, (error) => readError(operation.timeout, externalSignal, method, path, error));
      } catch (error) {
        if (error instanceof MetaApiError) {
          if (method !== "POST" || error.ambiguous) throw error;
          throw new MetaApiError({
            code: error.code,
            message: error.message,
            status: error.status,
            requestId,
            retryAfterMs: error.retryAfterMs,
            ambiguous: true,
          });
        }
        throw abortError(operation.timeout, externalSignal, method, path);
      }

      try {
        return { body: JSON.parse(text) as unknown, requestId };
      } catch {
        throw new MetaApiError({ code: "invalid_response", message: `Meta API returned invalid JSON for ${method} ${path}.`, requestId, ambiguous: method === "POST" });
      }
    }
  }

  private async waitBeforeRetry(retryAfterMs: number | undefined, attempt: number, signal: AbortSignal): Promise<boolean> {
    const exponentialCeiling = Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt);
    if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_DELAY_MS) return false;
    const delayMs = retryAfterMs === undefined
      ? Math.floor(this.random() * exponentialCeiling)
      : Math.min(MAX_RETRY_DELAY_MS, retryAfterMs + Math.floor(this.random() * 250));
    try {
      await this.sleep(delayMs, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async *readSse(
    body: ReadableStream<Uint8Array>,
    timeout: AbortSignal,
    external: AbortSignal | undefined,
    requestId: string | undefined,
  ): AsyncGenerator<Record<string, unknown>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    let terminal = false;

    const parseBlock = (block: string): Record<string, unknown> | undefined => {
      const data: string[] = [];
      let eventName: string | undefined;
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      }
      if (data.length === 0) return undefined;
      const source = data.join("\n");
      if (source === "[DONE]") {
        terminal = true;
        return undefined;
      }
      let event: unknown;
      try {
        event = JSON.parse(source);
      } catch {
        throw new MetaApiError({ code: "invalid_response", message: "Meta API returned malformed streaming event data.", requestId, ambiguous: true });
      }
      if (typeof event !== "object" || event === null || Array.isArray(event)) {
        throw new MetaApiError({ code: "invalid_response", message: "Meta API returned a malformed streaming event.", requestId, ambiguous: true });
      }
      const parsed = event as Record<string, unknown>;
      if (typeof parsed.type !== "string" && eventName) parsed.type = eventName;
      if (typeof parsed.type !== "string") {
        throw new MetaApiError({ code: "invalid_response", message: "Meta API returned an event without a type.", requestId, ambiguous: true });
      }
      return parsed;
    };

    try {
      while (true) {
        if (external?.aborted || timeout.aborted) throw abortError(timeout, external, "POST", "/responses stream");
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch {
          throw abortError(timeout, external, "POST", "/responses stream");
        }
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (totalBytes > MAX_STREAM_BYTES) {
          await reader.cancel();
          throw new MetaApiError({ code: "invalid_response", message: "Meta API stream exceeded the configured size limit.", requestId, ambiguous: true });
        }
        buffer += decoder.decode(next.value, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_EVENT_BYTES && !buffer.includes("\n\n") && !buffer.includes("\r\n\r\n")) {
          await reader.cancel();
          throw new MetaApiError({ code: "invalid_response", message: "Meta API sent an oversized stream event.", requestId, ambiguous: true });
        }

        while (true) {
          const lfBoundary = buffer.indexOf("\n\n");
          const crlfBoundary = buffer.indexOf("\r\n\r\n");
          const boundary = lfBoundary < 0 ? crlfBoundary : crlfBoundary < 0 ? lfBoundary : Math.min(lfBoundary, crlfBoundary);
          if (boundary < 0) break;
          const separatorLength = buffer.startsWith("\r\n\r\n", boundary) ? 4 : 2;
          const block = buffer.slice(0, boundary).replace(/\r\n/g, "\n");
          if (Buffer.byteLength(block, "utf8") > MAX_SSE_EVENT_BYTES) {
            await reader.cancel();
            throw new MetaApiError({ code: "invalid_response", message: "Meta API sent an oversized stream event.", requestId, ambiguous: true });
          }
          buffer = buffer.slice(boundary + separatorLength);
          const event = parseBlock(block);
          if (event) yield event;
          if (terminal) return;
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const event = parseBlock(buffer.replace(/\r\n/g, "\n"));
        if (event) yield event;
      }
      if (!terminal) {
        throw new MetaApiError({ code: "invalid_response", message: "Meta API stream ended before its terminal marker.", requestId, ambiguous: true });
      }
    } finally {
      if (!terminal) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already have closed or been cancelled by fetch.
        }
      }
      reader.releaseLock();
    }
  }
}
