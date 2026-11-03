import { z } from "zod";
import {
  MetaCodeEventSchema,
  type MetaConversationItem,
  type MetaCodeEvent,
  type MetaImageResult,
  type MetaPlanResult,
} from "@meta-game/contracts";
import type { MetaConfig } from "./config.js";
import { loadMetaConfig } from "./config.js";
import { MetaApiError } from "./errors.js";
import { runMetaSmoke, type MetaSmokeOptions, type MetaSmokeResult } from "./smoke.js";
import { MetaTransport } from "./transport.js";
import {
  assertCompleted,
  buildCodePayload,
  buildCodeStreamCompletion,
  buildPlanPayload,
  parseCompletedToolCalls,
  parsePlanResponse,
  ProviderResponseSchema,
  type ProviderResponse,
  type ProviderToolDefinition,
} from "./responses.js";
import { buildImagePayload, parseImageResponse } from "./images.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 32 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;
const MAX_TOOL_COUNT = 32;
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_IMAGE_REFERENCE_BYTES = 512 * 1024;

export interface MetaOperationOptions {
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface MetaToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: TSchema;
  inputJsonSchema?: Record<string, unknown>;
}

export interface MetaCodeRequest {
  prompt: string;
  context?: MetaConversationItem[];
  tools?: MetaToolDefinition[];
  parallelToolCalls?: boolean;
}

export type MetaImageReference = Readonly<{
  mimeType: "image/png";
  bytes: Uint8Array;
}>;

interface PreparedToolSet {
  definitions: ProviderToolDefinition[];
  validators: Map<string, z.ZodType>;
}

function boundedOutputTokens(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 16 || result > MAX_OUTPUT_TOKENS) {
    throw new MetaApiError({ code: "invalid_request", message: "maxOutputTokens must be an integer between 16 and 8192." });
  }
  return result;
}

function assertPrompt(prompt: string, maxBytes: number, label: string): void {
  if (typeof prompt !== "string" || prompt.trim().length === 0 || Buffer.byteLength(prompt, "utf8") > maxBytes) {
    throw new MetaApiError({ code: "invalid_request", message: `The ${label} must be non-empty and fit the configured size limit.` });
  }
}

function assertPayloadSize(payload: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new MetaApiError({ code: "invalid_request", message: "The Meta request contains non-serializable data." });
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
    throw new MetaApiError({ code: "invalid_request", message: "The Meta request exceeds the configured 1 MiB limit." });
  }
}

function prepareTools(tools: MetaToolDefinition[] | undefined): PreparedToolSet {
  const definitions: ProviderToolDefinition[] = [];
  const validators = new Map<string, z.ZodType>();
  if (!tools) return { definitions, validators };
  if (tools.length > MAX_TOOL_COUNT) {
    throw new MetaApiError({ code: "invalid_request", message: "A Meta request may define at most 32 tools." });
  }

  for (const tool of tools) {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(tool.name) || (tool.name.match(/\./g)?.length ?? 0) > 1 ||
        !tool.description.trim() || tool.description.length > 1_000 || validators.has(tool.name)) {
      throw new MetaApiError({ code: "invalid_request", message: "A Meta tool definition has an invalid or duplicate name or description." });
    }
    let parameters: unknown;
    try {
      parameters = tool.inputJsonSchema ?? z.toJSONSchema(tool.inputSchema, { target: "draft-7" });
    } catch {
      throw new MetaApiError({ code: "invalid_request", message: `Tool ${tool.name} uses a schema that cannot be sent to Meta.` });
    }
    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
      throw new MetaApiError({ code: "invalid_request", message: `Tool ${tool.name} must use an object schema.` });
    }
    const schema = { ...(parameters as Record<string, unknown>) };
    delete schema.$schema;
    if (schema.type !== "object") {
      throw new MetaApiError({ code: "invalid_request", message: `Tool ${tool.name} must use an object schema.` });
    }
    if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_TOOL_SCHEMA_BYTES) {
      throw new MetaApiError({ code: "invalid_request", message: `Tool ${tool.name} schema exceeds the configured size limit.` });
    }
    definitions.push({ name: tool.name, description: tool.description, parameters: schema });
    validators.set(tool.name, tool.inputSchema);
  }
  return { definitions, validators };
}

function asResponse(response: ProviderResponse): ProviderResponse {
  return response;
}

function eventObject(value: Record<string, unknown>, type: string): Record<string, unknown> | undefined {
  if (value.type !== type) return undefined;
  return value;
}

function codeEvent(value: unknown): MetaCodeEvent {
  const parsed = MetaCodeEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new MetaApiError({ code: "invalid_response", message: "Meta stream event did not match the internal contract." });
  }
  return parsed.data;
}

function streamItemId(event: Record<string, unknown>, item: Record<string, unknown>): string | undefined {
  if (typeof event.item_id === "string") return event.item_id;
  return typeof item.id === "string" ? item.id : undefined;
}

export class MetaClient {
  private readonly transport: MetaTransport;

  constructor(
    private readonly config: MetaConfig = loadMetaConfig(),
    fetchImpl: typeof fetch = fetch,
  ) {
    this.transport = new MetaTransport(config, fetchImpl);
  }

  async plan(prompt: string, options: MetaOperationOptions = {}): Promise<MetaPlanResult> {
    assertPrompt(prompt, 80 * 1024, "planning prompt");
    const payload = buildPlanPayload(this.config.modelPlan, prompt, boundedOutputTokens(options.maxOutputTokens, 1_024));
    assertPayloadSize(payload);
    const result = await this.transport.createResponse(payload, options.signal);
    assertCompleted(result.response, this.config.modelPlan);
    return parsePlanResponse(result.response, result.requestId);
  }

  async *streamCode(request: MetaCodeRequest, options: MetaOperationOptions = {}): AsyncGenerator<MetaCodeEvent> {
    assertPrompt(request.prompt, 256 * 1024, "code prompt");
    const toolSet = prepareTools(request.tools);
    const payload = buildCodePayload({
      model: this.config.modelCode,
      prompt: request.prompt,
      context: request.context ?? [],
      tools: toolSet.definitions,
      maxOutputTokens: boundedOutputTokens(options.maxOutputTokens, 4_096),
      parallelToolCalls: request.parallelToolCalls ?? true,
    });
    assertPayloadSize(payload);

    const { events, requestId } = await this.transport.openResponseStream(payload, options.signal);
    let finalResponse: ProviderResponse | undefined;
    let textBytes = 0;
    const argumentDeltas = new Map<string, string>();
    const finalizedArguments = new Map<string, string>();
    const completedItems = new Set<string>();
    const completedCallItems = new Map<string, { callId: string; name: string; arguments: string }>();

    for await (const event of events) {
      const type = typeof event.type === "string" ? event.type : "";
      if (finalResponse) {
        throw new MetaApiError({ code: "invalid_response", message: "Meta sent stream data after the completed response.", requestId, ambiguous: true });
      }
      const textDelta = eventObject(event, "response.output_text.delta")?.delta;
      if (typeof textDelta === "string") {
        textBytes += Buffer.byteLength(textDelta, "utf8");
        if (textBytes > 4 * 1024 * 1024) {
          throw new MetaApiError({ code: "invalid_response", message: "Meta code output exceeded the configured size limit.", requestId, ambiguous: true });
        }
        yield codeEvent({ type: "text_delta", delta: textDelta });
        continue;
      }

      if (type === "response.output_item.added") {
        const item = event.item;
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          const candidate = item as Record<string, unknown>;
          if (candidate.type === "function_call") {
            const itemId = streamItemId(event, candidate);
            if (!itemId || itemId.length > 128 || argumentDeltas.has(itemId)) {
              throw new MetaApiError({ code: "invalid_response", message: "Meta started a tool call without a valid item ID.", requestId, ambiguous: true });
            }
            argumentDeltas.set(itemId, typeof candidate.arguments === "string" ? candidate.arguments : "");
          }
        }
        continue;
      }

      if (type === "response.function_call_arguments.delta") {
        const itemId = event.item_id;
        const delta = event.delta;
        if (typeof itemId !== "string" || typeof delta !== "string" || !argumentDeltas.has(itemId)) {
          throw new MetaApiError({ code: "invalid_response", message: "Meta streamed tool arguments without a matching tool call.", requestId, ambiguous: true });
        }
        const current = argumentDeltas.get(itemId)! + delta;
        if (Buffer.byteLength(current, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
          throw new MetaApiError({ code: "invalid_response", message: "Meta streamed oversized tool arguments.", requestId, ambiguous: true });
        }
        argumentDeltas.set(itemId, current);
        continue;
      }

      if (type === "response.function_call_arguments.done") {
        const itemId = event.item_id;
        const argumentsValue = event.arguments;
        if (typeof itemId !== "string" || typeof argumentsValue !== "string" || !argumentDeltas.has(itemId)) {
          throw new MetaApiError({ code: "invalid_response", message: "Meta finalized tool arguments without a matching tool call.", requestId, ambiguous: true });
        }
        if (finalizedArguments.has(itemId)) {
          throw new MetaApiError({ code: "invalid_response", message: "Meta finalized the same tool call more than once.", requestId, ambiguous: true });
        }
        const accumulated = argumentDeltas.get(itemId)!;
        if (accumulated !== argumentsValue || Buffer.byteLength(argumentsValue, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
          throw new MetaApiError({ code: "invalid_response", message: "Meta streamed inconsistent tool arguments.", requestId, ambiguous: true });
        }
        finalizedArguments.set(itemId, argumentsValue);
        continue;
      }

      if (type === "response.output_item.done") {
        const item = event.item;
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          const candidate = item as Record<string, unknown>;
          if (candidate.type === "function_call") {
            const itemId = streamItemId(event, candidate);
            if (!itemId || completedItems.has(itemId) || candidate.status !== "completed" || !finalizedArguments.has(itemId) ||
                typeof candidate.arguments !== "string" || candidate.arguments !== finalizedArguments.get(itemId)) {
              throw new MetaApiError({ code: "invalid_response", message: "Meta did not complete a tool call with matching full arguments.", requestId, ambiguous: true });
            }
            completedItems.add(itemId);
            if (typeof candidate.call_id !== "string" || candidate.call_id.length < 1 || candidate.call_id.length > 64 ||
                typeof candidate.name !== "string" || typeof candidate.arguments !== "string") {
              throw new MetaApiError({ code: "invalid_response", message: "Meta completed a tool call with invalid metadata.", requestId, ambiguous: true });
            }
            completedCallItems.set(itemId, {
              callId: candidate.call_id,
              name: candidate.name,
              arguments: candidate.arguments,
            });
          }
        }
        continue;
      }

      if (type === "response.completed") {
        const parsed = event.response;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new MetaApiError({ code: "invalid_response", message: "Meta completed a stream without a response object.", requestId, ambiguous: true });
        }
        const response = ProviderResponseSchema.safeParse(parsed);
        if (!response.success) {
          throw new MetaApiError({ code: "invalid_response", message: "Meta completed a stream with an invalid response payload.", requestId, ambiguous: true });
        }
        finalResponse = asResponse(response.data);
        continue;
      }

      if (type === "response.failed") {
        throw new MetaApiError({ code: "provider_error", message: "Meta streaming response failed before completion.", requestId, ambiguous: true });
      }
      if (type === "response.incomplete") {
        const parsed = event.response;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const response = ProviderResponseSchema.safeParse(parsed);
          if (response.success) assertCompleted(response.data, this.config.modelCode);
        }
        throw new MetaApiError({ code: "incomplete_response", message: "Meta stream ended with an incomplete response.", requestId, ambiguous: true });
      }
      if (type === "response.cancelled") {
        throw new MetaApiError({ code: "cancelled", message: "Meta response was cancelled.", requestId, ambiguous: true });
      }
    }

    if (!finalResponse) {
      throw new MetaApiError({ code: "invalid_response", message: "Meta stream ended without a completed response.", requestId, ambiguous: true });
    }
    assertCompleted(finalResponse, this.config.modelCode);
    const streamedCalls = finalResponse.output.filter((item) => item.type === "function_call");
    if (streamedCalls.length !== completedItems.size || [...completedItems].some((id) => !finalizedArguments.has(id))) {
      throw new MetaApiError({ code: "invalid_response", message: "Meta completed before all tool calls were finalized.", requestId, ambiguous: true });
    }
    for (const item of streamedCalls) {
      if (typeof item.id !== "string" || item.status !== "completed" || typeof item.call_id !== "string" ||
          typeof item.name !== "string" || typeof item.arguments !== "string") {
        throw new MetaApiError({ code: "invalid_response", message: "Meta completed with an invalid tool call item.", requestId, ambiguous: true });
      }
      const streamed = completedCallItems.get(item.id);
      if (!streamed || streamed.callId !== item.call_id || streamed.name !== item.name || streamed.arguments !== item.arguments) {
        throw new MetaApiError({ code: "invalid_response", message: "Meta's final tool call differed from the completed stream item.", requestId, ambiguous: true });
      }
    }
    const calls = parseCompletedToolCalls(finalResponse, toolSet.validators);
    for (const call of calls) yield codeEvent({ type: "tool_call", ...call });
    const completion = buildCodeStreamCompletion(finalResponse, requestId);
    yield codeEvent({ type: "completed", ...completion });
  }

  async generateImage(prompt: string, options: Pick<MetaOperationOptions, "signal"> & { referenceImage?: MetaImageReference } = {}): Promise<MetaImageResult> {
    assertPrompt(prompt, 16 * 1024, "image prompt");
    if (options.referenceImage && (
      options.referenceImage.mimeType !== "image/png" ||
      !(options.referenceImage.bytes instanceof Uint8Array) ||
      options.referenceImage.bytes.byteLength < 1 ||
      options.referenceImage.bytes.byteLength > MAX_IMAGE_REFERENCE_BYTES ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => options.referenceImage!.bytes[index] === value)
    )) {
      throw new MetaApiError({ code: "invalid_request", message: "The Meta image reference must be a bounded PNG." });
    }
    const payload = buildImagePayload(this.config.modelImage, prompt, options.referenceImage
      ? { mimeType: options.referenceImage.mimeType, base64: Buffer.from(options.referenceImage.bytes).toString("base64") }
      : undefined);
    assertPayloadSize(payload);
    const result = await this.transport.createResponse(payload, options.signal);
    assertCompleted(result.response, this.config.modelImage);
    return parseImageResponse(result.response, result.requestId);
  }

  async editImage(
    prompt: string,
    referenceImage: MetaImageReference,
    options: Pick<MetaOperationOptions, "signal"> = {},
  ): Promise<MetaImageResult> {
    if (!referenceImage) {
      throw new MetaApiError({ code: "invalid_request", message: "An explicit image reference is required for image editing." });
    }
    return this.generateImage(prompt, { ...options, referenceImage });
  }

  async smokeTest(options: MetaSmokeOptions = {}, signal?: AbortSignal): Promise<MetaSmokeResult> {
    return runMetaSmoke(this.config, options, this.transport, signal);
  }

  static toolResult(callId: string, value: unknown): MetaConversationItem {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(callId)) {
      throw new MetaApiError({ code: "invalid_request", message: "Tool result call ID is invalid." });
    }
    let output: string;
    try {
      output = JSON.stringify(value);
    } catch {
      throw new MetaApiError({ code: "invalid_request", message: "Tool result must be JSON serializable." });
    }
    if (output === undefined || Buffer.byteLength(output, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
      throw new MetaApiError({ code: "invalid_request", message: "Tool result exceeds the configured size limit." });
    }
    return { kind: "tool_result", callId, output };
  }
}
