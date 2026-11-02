import { describe, expect, it, vi } from "vitest";
import {
  loadMetaConfig,
  MetaApiError,
  MetaConfigurationError,
  MetaSmokeError,
  parseMetaSmokeOptions,
  runMetaSmoke,
} from "@meta-game/meta";
import { MetaTransport } from "../packages/meta/src/transport.js";

const spark = "muse-spark-1.3-contributor";
const image = "muse-image-1.0";
const availableModels = [spark, image];

function config(overrides: Record<string, string | undefined> = {}) {
  return loadMetaConfig({
    META_API_KEY: "test-secret-key",
    META_BASE_URL: "https://api.meta.ai/v1",
    META_MODEL_PLAN: spark,
    META_MODEL_CODE: spark,
    META_MODEL_IMAGE: image,
    META_TIMEOUT_MS: "2000",
    ...overrides,
  });
}

function httpResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  const combinedHeaders = new Headers(headers);
  combinedHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), { status, headers: combinedHeaders });
}

function modelList(ids = availableModels) {
  return { object: "list", data: ids.map((id) => ({ id, object: "model" })) };
}

function textResponse(id = "resp_text") {
  return {
    id,
    model: spark,
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "META_SMOKE_OK" }] }],
  };
}

describe("Meta API smoke configuration", () => {
  it("fails without a key and does not reveal key-shaped input", () => {
    expect(() => loadMetaConfig({ META_API_KEY: "  " })).toThrow(MetaConfigurationError);
    expect(() => loadMetaConfig({ META_API_KEY: "secret-that-must-not-appear\n" })).toThrow(MetaConfigurationError);
  });

  it.each([
    "http://api.meta.ai/v1",
    "https://example.invalid/v1",
    "https://api.meta.ai.evil.invalid/v1",
    "https://user:password@api.meta.ai/v1",
    "https://api.meta.ai/v1?redirect=https://example.invalid",
  ])("rejects a non-allowlisted base URL: %s", (baseUrl) => {
    expect(() => config({ META_BASE_URL: baseUrl })).toThrow(MetaConfigurationError);
  });

  it("validates timeout and model ID format", () => {
    expect(() => config({ META_TIMEOUT_MS: "250" })).toThrow("META_TIMEOUT_MS");
    expect(() => config({ META_MODEL_PLAN: "invalid model id" })).toThrow("META_MODEL_PLAN");
  });

  it("accepts only explicit smoke flags", () => {
    expect(parseMetaSmokeOptions(["--tools", "--image"])).toEqual({ help: false, checkTools: true, checkImage: true });
    expect(parseMetaSmokeOptions(["--help"])).toEqual({ help: true, checkTools: false, checkImage: false });
    expect(() => parseMetaSmokeOptions(["--api-key", "secret"])).toThrow("Unknown smoke test option.");
  });
});

describe("Meta API transport", () => {
  it("uses the server-side Bearer key and official Responses endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(httpResponse(textResponse(), 200, { "x-request-id": "req-safe-123" }));
    const transport = new MetaTransport(config(), fetchMock, { maxRetries: 0 });

    const result = await transport.createResponse({ model: spark, input: "synthetic", store: false, max_output_tokens: 64 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.meta.ai/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-secret-key");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: spark, store: false, max_output_tokens: 64 });
    expect(result.requestId).toBe("req-safe-123");
    expect(result.response.id).toBe("resp_text");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "http_error"],
    [429, "rate_limited"],
    [503, "provider_error"],
  ] as const)("normalizes and sanitizes HTTP %i error responses", async (status, code) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(httpResponse({ error: { message: "test-secret-key must never leak" } }, status));
    const transport = new MetaTransport(config(), fetchMock, { maxRetries: 0 });
    let error: unknown;
    try {
      await transport.listModels();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MetaApiError);
    expect((error as Error).message).not.toContain("test-secret-key");
    expect(error).toMatchObject({ status, code });
  });

  it("sanitizes network errors and timeouts", async () => {
    const networkMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("test-secret-key should not leak"));
    let networkError: unknown;
    try {
      await new MetaTransport(config(), networkMock).listModels();
    } catch (caught) {
      networkError = caught;
    }
    expect((networkError as Error).message).toContain("could not be reached");
    expect((networkError as Error).message).not.toContain("test-secret-key");

    const timeoutMock = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    await expect(new MetaTransport(config(), timeoutMock).listModels()).rejects.toMatchObject({ code: "timeout" });

    const bodyTimeout = {
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockRejectedValue(new DOMException("timeout", "TimeoutError")),
    } as unknown as Response;
    const bodyTimeoutMock = vi.fn<typeof fetch>().mockResolvedValue(bodyTimeout);
    await expect(new MetaTransport(config(), bodyTimeoutMock).listModels()).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects invalid JSON and schema without including response content", async () => {
    const invalidJsonFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("test-secret-key malformed", { status: 200 }));
    let jsonError: unknown;
    try {
      await new MetaTransport(config(), invalidJsonFetch).listModels();
    } catch (caught) {
      jsonError = caught;
    }
    expect(jsonError).toBeInstanceOf(MetaApiError);
    expect((jsonError as Error).message).not.toContain("test-secret-key");

    const invalidSchemaFetch = vi.fn<typeof fetch>().mockResolvedValue(httpResponse({ data: "test-secret-key" }));
    await expect(new MetaTransport(config(), invalidSchemaFetch).listModels()).rejects.toThrow("invalid model list");
  });
});

describe("Meta connectivity smoke", () => {
  it("checks configured model access and a minimal text response", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(httpResponse(modelList()))
      .mockResolvedValueOnce(httpResponse(textResponse()));

    const result = await runMetaSmoke(config(), {}, new MetaTransport(config(), fetchMock));

    expect(result.modelIds).toEqual([spark, spark, image]);
    expect(result.responseId).toBe("resp_text");
    expect(result.textPreview).toBe("META_SMOKE_OK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails before sending a prompt when a configured model is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(httpResponse(modelList([spark])));

    await expect(runMetaSmoke(config(), {}, new MetaTransport(config(), fetchMock))).rejects.toThrow(MetaSmokeError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports only a safe status when the provider does not complete", async () => {
    const incomplete = { ...textResponse(), status: "incomplete" };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(httpResponse(modelList()))
      .mockResolvedValueOnce(httpResponse(incomplete));

    await expect(runMetaSmoke(config(), {}, new MetaTransport(config(), fetchMock))).rejects.toThrow("status incomplete");
  });

  it("checks a function call and its matched result when opted in", async () => {
    const toolCall = {
      id: "resp_tool_call",
      model: spark,
      status: "completed",
      output: [{ type: "function_call", call_id: "call_1", name: "smoke_ping", arguments: '{"message":"META_SMOKE_OK"}' }],
    };
    const followup = { ...textResponse("resp_tool_result"), model: spark };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(httpResponse(modelList()))
      .mockResolvedValueOnce(httpResponse(textResponse()))
      .mockResolvedValueOnce(httpResponse(toolCall))
      .mockResolvedValueOnce(httpResponse(followup));

    const result = await runMetaSmoke(config(), { checkTools: true }, new MetaTransport(config(), fetchMock));

    expect(result.toolResponseId).toBe("resp_tool_result");
    const followupBody = JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body)) as { input: unknown[]; store: boolean };
    expect(followupBody.input).toMatchObject([
      { type: "function_call", call_id: "call_1" },
      { type: "function_call_output", call_id: "call_1" },
    ]);
    expect(followupBody.store).toBe(false);
  });

  it("checks an image result when opted in without exposing the image payload", async () => {
    const imageResponse = {
      id: "resp_image",
      model: image,
      status: "completed",
      output: [{ type: "image_generation_call", status: "completed", result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=" }],
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(httpResponse(modelList()))
      .mockResolvedValueOnce(httpResponse(textResponse()))
      .mockResolvedValueOnce(httpResponse(imageResponse));

    const result = await runMetaSmoke(config(), { checkImage: true }, new MetaTransport(config(), fetchMock));

    expect(result.imageResponseId).toBe("resp_image");
    expect(JSON.stringify(result)).not.toContain("iVBORw0KGgo");
  });
});

describe("Meta API retry safety", () => {
  it("retries bounded safe model-list reads using Retry-After", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(httpResponse({ error: { message: "temporary" } }, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(httpResponse(modelList()));
    const sleep = vi.fn(async () => undefined);
    const transport = new MetaTransport(config(), fetchMock, { sleep, random: () => 0.5 });

    const result = await transport.listModels();

    expect(result.ids).toEqual(availableModels);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not retry a billable response POST after an ambiguous provider failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(httpResponse({ error: { message: "private provider detail" } }, 503, { "retry-after": "0" }));
    const transport = new MetaTransport(config(), fetchMock);

    await expect(transport.createResponse({ model: spark, input: "synthetic", store: false })).rejects.toMatchObject({
      code: "provider_error",
      status: 503,
      ambiguous: true,
      retryAfterMs: 0,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
