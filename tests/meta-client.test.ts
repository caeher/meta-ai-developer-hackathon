import { readFile } from "node:fs/promises";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { MetaClient, loadMetaConfig } from "@meta-game/meta";
import type { MetaConversationItem } from "@meta-game/contracts";
import { agentToolDefinitions } from "../apps/worker/src/agent/tools";

const spark = "muse-spark-1.3-contributor";
const imageModel = "muse-image-1.0";

function config() {
  return loadMetaConfig({
    META_API_KEY: "fixture-key-only",
    META_BASE_URL: "https://api.meta.ai/v1",
    META_MODEL_PLAN: spark,
    META_MODEL_CODE: spark,
    META_MODEL_IMAGE: imageModel,
    META_TIMEOUT_MS: "5000",
  });
}

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  const allHeaders = new Headers(headers);
  allHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), { status, headers: allHeaders });
}

function streamResponse(body: string, chunkSize = 17): Response {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "x-request-id": "req_fixture_123" } });
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../packages/meta/test/fixtures/${name}`, import.meta.url), "utf8");
}

const tools = [{
  name: "writeFile",
  description: "Write a file inside the isolated project workspace.",
  inputSchema: z.object({ path: z.string().min(1).max(256), contents: z.string().max(10_000) }).strict(),
}];

describe("MetaClient plan and image contracts", () => {
  it("requests a structured visible plan and normalizes usage", async () => {
    const response = JSON.parse(await fixture("text-response.json")) as unknown;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response, 200, { "x-request-id": "req_plan_1" }));
    const client = new MetaClient(config(), fetchMock);

    const result = await client.plan("Create a small platform game.");

    expect(result).toMatchObject({
      plan: { summary: "Create a compact platform game prototype.", objective: "Create a playable platform scene with bounded movement.", steps: [{ id: "scene", expectedFiles: ["src/main.ts", "src/game.ts"], verifications: ["Run the configured build script."] }] },
      model: spark,
      responseId: "resp_fixture_plan_01",
      requestId: "req_plan_1",
      usage: { inputTokens: 45, outputTokens: 23, totalTokens: 68, reasoningTokens: 8 },
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.meta.ai/v1/responses");
    expect(body.model).toBe(spark);
    expect(body.store).toBe(false);
    expect(body.text).toMatchObject({ format: { type: "json_schema", name: "game_creation_plan", strict: true } });
    expect(body).not.toHaveProperty("response_format");
  });

  it("rejects malformed visible plans and invalid usage", async () => {
    const valid = JSON.parse(await fixture("text-response.json")) as Record<string, unknown>;
    const output = valid.output as Array<Record<string, unknown>>;
    output[0]!.content = [{ type: "output_text", text: "{not json" }];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(valid));
    await expect(new MetaClient(config(), fetchMock).plan("Make a game.")).rejects.toMatchObject({ code: "invalid_response" });

    const invalidUsage = JSON.parse(await fixture("text-response.json")) as Record<string, unknown>;
    invalidUsage.usage = { input_tokens: 20, output_tokens: 20, total_tokens: 10 };
    const invalidUsageFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(invalidUsage));
    await expect(new MetaClient(config(), invalidUsageFetch).plan("Make a game.")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("classifies unavailable models without selecting a fallback", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: { message: "private provider details" } }, 404));
    await expect(new MetaClient(config(), fetchMock).plan("Make a game.")).rejects.toMatchObject({ code: "model_unavailable", status: 404 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts bounded PNG image bytes and rejects invalid image data", async () => {
    const valid = JSON.parse(await fixture("image-response.json")) as unknown;
    const validFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(valid));
    const image = await new MetaClient(config(), validFetch).generateImage("Pixel-art blue star.");
    expect(image).toMatchObject({ mimeType: "image/png", width: 1, height: 1, model: imageModel, responseId: "resp_fixture_image_01" });
    expect(image.bytes.byteLength).toBeGreaterThan(0);
    const body = JSON.parse(String((validFetch.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: imageModel, store: false, tools: [{
      type: "image_generation",
      enable_image_search: false,
      enable_web_search: false,
      enable_shell: false,
      output_format: "png",
    }] });

    const invalid = JSON.parse(await fixture("invalid-image-response.json")) as unknown;
    const invalidFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(invalid));
    await expect(new MetaClient(config(), invalidFetch).generateImage("Pixel-art blue star.")).rejects.toMatchObject({ code: "invalid_image" });
  });

  it("sends a bounded same-project PNG reference as input_image data without enabling search", async () => {
    const valid = JSON.parse(await fixture("image-response.json")) as unknown;
    const seedFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(valid));
    const reference = await new MetaClient(config(), seedFetch).generateImage("Pixel-art blue star.");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(valid));

    await new MetaClient(config(), fetchMock).editImage(
      "Edit the requested sprite frame while matching its source palette.",
      { mimeType: "image/png", bytes: reference.bytes },
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.input).toEqual([{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Edit the requested sprite frame while matching its source palette." },
        { type: "input_image", image_url: `data:image/png;base64,${Buffer.from(reference.bytes).toString("base64")}` },
      ],
    }]);
    expect(body.tools).toMatchObject([{ enable_image_search: false, enable_web_search: false, enable_shell: false }]);

    const invalidFetch = vi.fn<typeof fetch>();
    await expect(new MetaClient(config(), invalidFetch).generateImage("Draw something.", {
      referenceImage: { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    })).rejects.toMatchObject({ code: "invalid_request" });
    expect(invalidFetch).not.toHaveBeenCalled();
  });
});

describe("MetaClient streaming and tool replay", () => {
  it("expone edit_sprite con un sourceAssetId explícito y restricciones cerradas", async () => {
    const completed = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_edit_schema_fixture\",\"model\":\"muse-spark-1.3-contributor\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"status\":\"completed\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done.\"}]}]}}\n\ndata: [DONE]\n\n";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(completed));
    const editTool = agentToolDefinitions.find(({ name }) => name === "edit_sprite");
    expect(editTool?.inputJsonSchema).toBeDefined();
    const client = new MetaClient(config(), fetchMock);
    for await (const event of client.streamCode({ prompt: "Edit the supplied sprite only.", tools: editTool ? [editTool] : [] })) {
      expect(event.type).toBe("completed");
    }
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { tools: Array<{ name: string; parameters: Record<string, unknown> }> };
    const schema = body.tools[0]?.parameters;
    expect(body.tools[0]?.name).toBe("edit_sprite");
    expect(schema?.required).toEqual(expect.arrayContaining(["sourceAssetId", "requestedChange", "preserve"]));
    expect(schema?.additionalProperties).toBe(false);
    expect((schema?.properties as Record<string, Record<string, unknown>>).sourceFrameIndex).toMatchObject({ minimum: 0, maximum: 63, default: 0 });
    expect((schema?.properties as Record<string, Record<string, unknown>>).palette).toMatchObject({ uniqueItems: true, maxItems: 8 });
    expect((schema?.properties as Record<string, Record<string, unknown>>).preserve).toMatchObject({ required: ["canvas", "style", "palette", "characterIdentity"] });
  });

  it("expone create_tileset como composición determinista acotada y sin destinos editables", async () => {
    const completed = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_tileset_schema_fixture\",\"model\":\"muse-spark-1.3-contributor\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"status\":\"completed\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done.\"}]}]}}\n\ndata: [DONE]\n\n";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(completed));
    const createTilesetTool = agentToolDefinitions.find(({ name }) => name === "create_tileset");
    expect(createTilesetTool?.inputJsonSchema).toBeDefined();
    const client = new MetaClient(config(), fetchMock);
    for await (const event of client.streamCode({ prompt: "Pack the validated terrain tiles.", tools: createTilesetTool ? [createTilesetTool] : [] })) {
      expect(event.type).toBe("completed");
    }
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { tools: Array<{ name: string; parameters: Record<string, unknown> }> };
    const schema = body.tools[0]?.parameters;
    expect(body.tools[0]?.name).toBe("create_tileset");
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(expect.arrayContaining(["name", "tileSize", "tiles"]));
    expect((schema?.properties as Record<string, Record<string, unknown>>).columns).toMatchObject({ minimum: 1, maximum: 16 });
    const tileSchema = (schema?.properties as Record<string, Record<string, unknown>>).tiles?.items as Record<string, unknown>;
    expect(tileSchema.required).toEqual(expect.arrayContaining(["sourceAssetId", "tileName"]));
    expect(tileSchema.additionalProperties).toBe(false);
    expect((tileSchema.properties as Record<string, Record<string, unknown>>).sourceFrameIndex).toMatchObject({ minimum: 0, maximum: 63, default: 0 });
  });

  it("sends the inspect_asset Draft-7 source exclusivity schema to the provider", async () => {
    const completed = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_schema_fixture\",\"model\":\"muse-spark-1.3-contributor\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"status\":\"completed\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done.\"}]}]}}\n\ndata: [DONE]\n\n";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(completed));
    const inspectTool = agentToolDefinitions.find(({ name }) => name === "inspect_asset");
    expect(inspectTool?.inputJsonSchema).toBeDefined();
    const client = new MetaClient(config(), fetchMock);
    for await (const event of client.streamCode({ prompt: "Inspect the current atlas.", tools: inspectTool ? [inspectTool] : [] })) {
      expect(event.type).toBe("completed");
    }
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { tools: Array<{ parameters: Record<string, unknown> }> };
    expect(body.tools[0]?.parameters.oneOf).toEqual([
      { required: ["assetId"], not: { required: ["workspacePath"] } },
      { required: ["workspacePath"], not: { required: ["assetId"] } },
    ]);
  });

  it("assembles fragmented parallel tool calls and emits them only when the response completes", async () => {
    const body = await fixture("code-stream.sse");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(body, 3));
    const client = new MetaClient(config(), fetchMock);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];

    for await (const event of client.streamCode({ prompt: "Add a title screen.", tools })) emitted.push(event);

    expect(emitted.map((event) => event.type)).toEqual(["text_delta", "tool_call", "tool_call", "completed"]);
    expect(emitted[1]).toMatchObject({ type: "tool_call", callId: "call_a", name: "writeFile", arguments: { path: "src/main.ts" } });
    expect(emitted[2]).toMatchObject({ type: "tool_call", callId: "call_b", name: "writeFile", arguments: { path: "src/game.ts" } });
    const completion = emitted[3]!;
    expect(completion).toMatchObject({ type: "completed", responseId: "resp_fixture_code_01", requestId: "req_fixture_123" });
    expect(completion.replay).toEqual(expect.arrayContaining([
      { kind: "reasoning_replay", encryptedContent: "opaque-fixture-replay" },
      expect.objectContaining({ kind: "tool_call", callId: "call_a" }),
    ]));
    expect(JSON.stringify(completion)).not.toContain("chain of thought");

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(firstBody).toMatchObject({ model: spark, store: false, stream: true, include: ["reasoning.encrypted_content"] });
    expect(firstBody.tools).toMatchObject([{ type: "function", name: "writeFile", parameters: { type: "object" } }]);
    expect(firstBody).not.toHaveProperty("previous_response_id");
  });

  it("exposes the previous smoke contract through MetaClient", async () => {
    const modelList = { object: "list", data: [{ id: spark }, { id: imageModel }] };
    const text = { id: "resp_smoke_fixture", model: spark, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "SMOKE_OK" }] }] };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(modelList)).mockResolvedValueOnce(jsonResponse(text));
    const result = await new MetaClient(config(), fetchMock).smokeTest();
    expect(result).toMatchObject({ responseId: "resp_smoke_fixture", textPreview: "SMOKE_OK" });
  });

  it("correlates replayed tool results by call ID and does not retry a streaming POST", async () => {
    const firstBody = await fixture("code-stream.sse");
    const second = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_followup\",\"model\":\"muse-spark-1.3-contributor\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"status\":\"completed\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Done.\"}]}]}}\n\ndata: [DONE]\n\n";
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse(firstBody))
      .mockResolvedValueOnce(streamResponse(second));
    const client = new MetaClient(config(), fetchMock);
    let replay: MetaConversationItem[] = [];
    for await (const event of client.streamCode({ prompt: "Create files.", tools })) {
      if (event.type === "completed") replay = event.replay;
    }

    const context = [
      ...replay,
      MetaClient.toolResult("call_a", { ok: true }),
      MetaClient.toolResult("call_b", { ok: true }),
    ];
    let followupCompleted = false;
    for await (const event of client.streamCode({ prompt: "Continue.", context })) {
      if (event.type === "completed") followupCompleted = true;
    }
    expect(followupCompleted).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as { input: Array<Record<string, unknown>>; store: boolean };
    const call = body.input.find((item) => item.type === "function_call");
    const outputs = body.input.filter((item) => item.type === "function_call_output");
    expect(call).toMatchObject({ call_id: "call_a", name: "writeFile" });
    expect(outputs).toEqual([
      { type: "function_call_output", call_id: "call_a", output: "{\"ok\":true}" },
      { type: "function_call_output", call_id: "call_b", output: "{\"ok\":true}" },
    ]);
    expect(body.store).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unmatched or out-of-order tool results before sending a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new MetaClient(config(), fetchMock);
    const unmatched = [{ kind: "tool_result", callId: "call_a", output: "{}" }] as MetaConversationItem[];
    await expect((async () => {
      for await (const event of client.streamCode({ prompt: "Continue.", context: unmatched })) expect(event.type).toBeDefined();
    })()).rejects.toMatchObject({ code: "invalid_request" });

    const outOfOrder = [
      { kind: "tool_result", callId: "call_a", output: "{}" },
      { kind: "tool_call", callId: "call_a", name: "writeFile", arguments: { path: "src/main.ts", contents: "" } },
    ] as MetaConversationItem[];
    await expect((async () => {
      for await (const event of client.streamCode({ prompt: "Continue.", context: outOfOrder })) expect(event.type).toBeDefined();
    })()).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate call IDs, incomplete argument streams, and schema-invalid arguments", async () => {
    const base = await fixture("code-stream.sse");
    const duplicate = base.replaceAll("call_b", "call_a");
    const duplicateFetch = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(duplicate));
    const duplicateClient = new MetaClient(config(), duplicateFetch);
    let emittedCalls = 0;
    await expect((async () => {
      for await (const event of duplicateClient.streamCode({ prompt: "Create files.", tools })) {
        if (event.type === "tool_call") emittedCalls += 1;
      }
    })()).rejects.toMatchObject({ code: "invalid_response" });
    expect(emittedCalls).toBe(0);

    const lateEvent = base.replace("data: [DONE]", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"late\"}\n\ndata: [DONE]");
    const lateEventFetch = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(lateEvent));
    const lateToolCalls: string[] = [];
    await expect((async () => {
      for await (const event of new MetaClient(config(), lateEventFetch).streamCode({ prompt: "Create files.", tools })) {
        if (event.type === "tool_call") lateToolCalls.push(event.callId);
      }
    })()).rejects.toMatchObject({ code: "invalid_response" });
    expect(lateToolCalls).toEqual([]);

    const incomplete = base.split("\n").filter((line) => !(line.includes("response.function_call_arguments.done") && line.includes("fc_item_a"))).join("\n");
    const incompleteFetch = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(incomplete));
    await expect((async () => {
      for await (const event of new MetaClient(config(), incompleteFetch).streamCode({ prompt: "Create files.", tools })) {
        expect(event.type).toBeDefined();
      }
    })()).rejects.toMatchObject({ code: "invalid_response" });

    const wrongSchemaTools = [{
      ...tools[0]!,
      inputSchema: z.object({ path: z.number(), contents: z.string() }).strict(),
    }];
    const wrongArgsFetch = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(base));
    await expect((async () => {
      for await (const event of new MetaClient(config(), wrongArgsFetch).streamCode({ prompt: "Create files.", tools: wrongSchemaTools })) {
        expect(event.type).toBeDefined();
      }
    })()).rejects.toMatchObject({ code: "invalid_tool_arguments" });
  });

  it("propagates AbortSignal cancellation before any tool call is dispatched", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const client = new MetaClient(config(), fetchMock);
    const stream = client.streamCode({ prompt: "Make a game.", tools }, { signal: controller.signal });
    const pending = stream.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
