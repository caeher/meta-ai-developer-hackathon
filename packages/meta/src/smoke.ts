import type { MetaConfig } from "./config.js";
import { MetaApiError } from "./errors.js";
import { MetaTransport } from "./transport.js";
import { parseImageResponse, type ProviderResponse } from "./responses.js";

const TEXT_PROMPT = "Reply with exactly META_SMOKE_OK.";
const TOOL_OUTPUT = "META_SMOKE_OK";
const REQUIRED_MODELS = ["plan", "code", "image"] as const;

export interface MetaSmokeOptions {
  checkTools?: boolean;
  checkImage?: boolean;
}

export interface MetaSmokeCliOptions extends MetaSmokeOptions {
  help: boolean;
}

export function parseMetaSmokeOptions(args: string[]): MetaSmokeCliOptions {
  const options: MetaSmokeCliOptions = { help: false, checkTools: false, checkImage: false };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--tools") options.checkTools = true;
    else if (arg === "--image") options.checkImage = true;
    else throw new Error("Unknown smoke test option.");
  }
  return options;
}

export interface MetaSmokeResult {
  modelIds: string[];
  responseId: string;
  textPreview: string;
  toolResponseId?: string;
  imageResponseId?: string;
}

export class MetaSmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaSmokeError";
  }
}

function outputText(response: ProviderResponse): string {
  if (response.output_text?.trim()) return response.output_text.trim();

  const chunks: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (typeof content !== "object" || content === null) continue;
      const part = content as Record<string, unknown>;
      if (part.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
    }
  }

  return chunks.join("\n").trim();
}

function assertCompleted(response: ProviderResponse, model: string): void {
  if (response.model !== model) {
    throw new MetaSmokeError("Meta API response model did not match the configured model.");
  }
  if (response.status !== "completed") {
    const status = ["incomplete", "failed", "cancelled", "in_progress", "queued"].includes(response.status)
      ? response.status
      : "unknown";
    const rawReason = response.incomplete_details?.reason;
    const reason = rawReason && ["max_output_tokens", "content_filter"].includes(rawReason) ? ` (${rawReason})` : "";
    throw new MetaSmokeError(`Meta API response ended with status ${status}${reason}.`);
  }
}

function textPreview(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 120);
}

function findFunctionCall(response: ProviderResponse): { callId: string; name: string; arguments: string } {
  const item = response.output.find((candidate) => candidate.type === "function_call");
  if (!item || typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") {
    throw new MetaSmokeError("Meta API did not return a valid smoke function call.");
  }
  if (item.name !== "smoke_ping" || item.call_id.length < 1 || item.call_id.length > 64) {
    throw new MetaSmokeError("Meta API returned an unexpected smoke function call.");
  }

  let args: unknown;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    throw new MetaSmokeError("Meta API returned invalid arguments for the smoke function call.");
  }
  if (typeof args !== "object" || args === null || Array.isArray(args) || (args as Record<string, unknown>).message !== TOOL_OUTPUT) {
    throw new MetaSmokeError("Meta API returned invalid arguments for the smoke function call.");
  }

  return { callId: item.call_id, name: item.name, arguments: item.arguments };
}

function hasImageResult(response: ProviderResponse): boolean {
  try {
    parseImageResponse(response);
    return true;
  } catch {
    return false;
  }
}

export async function runMetaSmoke(
  config: MetaConfig,
  options: MetaSmokeOptions = {},
  transport: MetaTransport = new MetaTransport(config),
  signal?: AbortSignal,
): Promise<MetaSmokeResult> {
  const listed = await transport.listModels(signal);
  const configured = {
    plan: config.modelPlan,
    code: config.modelCode,
    image: config.modelImage,
  };
  const available = new Set(listed.ids);
  const missing = REQUIRED_MODELS.filter((name) => !available.has(configured[name]));
  if (missing.length > 0) {
    const ids = missing.map((name) => `${name}=${configured[name]}`).join(", ");
    throw new MetaSmokeError(`Configured models are unavailable to this account: ${ids}.`);
  }

  const textResult = await transport.createResponse({
    model: config.modelPlan,
    input: TEXT_PROMPT,
    max_output_tokens: 256,
    reasoning: { effort: "low" },
    store: false,
  }, signal);
  assertCompleted(textResult.response, config.modelPlan);
  const text = outputText(textResult.response);
  if (!text) throw new MetaSmokeError("Meta API response did not contain generated text.");

  const result: MetaSmokeResult = {
    modelIds: [config.modelPlan, config.modelCode, config.modelImage],
    responseId: textResult.response.id,
    textPreview: textPreview(text),
  };

  if (options.checkTools) {
    const toolCallResult = await transport.createResponse({
      model: config.modelCode,
      input: "Call smoke_ping with the message META_SMOKE_OK. Do not answer with text.",
      max_output_tokens: 128,
      store: false,
      tools: [{
        type: "function",
        name: "smoke_ping",
        description: "Connectivity check only. Return a fixed synthetic message.",
        parameters: {
          type: "object",
          properties: { message: { type: "string", enum: [TOOL_OUTPUT] } },
          required: ["message"],
          additionalProperties: false,
        },
        strict: true,
      }],
      tool_choice: "auto",
    }, signal);
    assertCompleted(toolCallResult.response, config.modelCode);
    const functionCall = findFunctionCall(toolCallResult.response);

    const toolOutputResult = await transport.createResponse({
      model: config.modelCode,
      input: [
        {
          type: "function_call",
          call_id: functionCall.callId,
          name: functionCall.name,
          arguments: functionCall.arguments,
        },
        {
          type: "function_call_output",
          call_id: functionCall.callId,
          output: JSON.stringify({ message: TOOL_OUTPUT }),
        },
      ],
      max_output_tokens: 64,
      store: false,
    }, signal);
    assertCompleted(toolOutputResult.response, config.modelCode);
    if (!outputText(toolOutputResult.response)) {
      throw new MetaSmokeError("Meta API did not accept the smoke function output.");
    }
    result.toolResponseId = toolOutputResult.response.id;
  }

  if (options.checkImage) {
    const imageResult = await transport.createResponse({
      model: config.modelImage,
      input: "Create one simple 16-bit pixel-art blue star on a plain transparent background; no text.",
      store: false,
    }, signal);
    assertCompleted(imageResult.response, config.modelImage);
    if (!hasImageResult(imageResult.response)) {
      throw new MetaSmokeError("Meta API did not return a valid image-generation result.");
    }
    result.imageResponseId = imageResult.response.id;
  }

  return result;
}

export function isSafeMetaSmokeError(error: unknown): error is MetaSmokeError | MetaApiError {
  return error instanceof MetaSmokeError || error instanceof MetaApiError;
}
