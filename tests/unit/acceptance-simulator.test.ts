import { describe, expect, it } from "vitest";
import { createAcceptanceSimulatorMeta } from "../../apps/worker/src/agent/acceptance-simulator";
import type { MetaCodeEvent, MetaConversationItem } from "@meta-game/contracts";

describe("local acceptance generation simulator", () => {
  it("plans locally and writes a digging project spec without provider usage", async () => {
    const meta = createAcceptanceSimulatorMeta();
    const request = "Crea Esmeralda Profunda, un juego Boulder Dash de excavación. Usa WASD, recoge gemas y esquiva rocas que caen.";
    const plan = await meta.plan(request);
    expect(plan).toMatchObject({ model: "local-acceptance-simulator", usage: { totalTokens: 0 }, plan: { steps: expect.any(Array) } });

    const events: MetaCodeEvent[] = [];
    for await (const event of meta.streamCode({ prompt: `User request:\n${request}\n\nApproved plan:\n{}`, context: [], tools: [] })) events.push(event);
    const call = events.find((event) => event.type === "tool_call");
    expect(call).toMatchObject({ type: "tool_call", name: "write_file", arguments: { path: "src/game/project-spec.json" } });
    if (call?.type !== "tool_call") throw new Error("simulator_write_call_missing");
    const spec = JSON.parse(String((call.arguments as { content: string }).content)) as Record<string, unknown>;
    expect(spec).toMatchObject({ title: "Esmeralda Profunda", genre: "puzzle", mode: "digging", controls: { movement: "wasd" } });
    const completion = events.find((event) => event.type === "completed");
    expect(completion).toMatchObject({ type: "completed", model: "local-acceptance-simulator", usage: { totalTokens: 0 } });

    const followupContext: MetaConversationItem[] = [
      ...(completion?.type === "completed" ? completion.replay : []),
      { kind: "tool_result", callId: call.callId, output: "{\"path\":\"src/game/project-spec.json\",\"bytesWritten\":512}" },
    ];
    const finalEvents: MetaCodeEvent[] = [];
    for await (const event of meta.streamCode({ prompt: `User request:\n${request}\n\nApproved plan:\n{}`, context: followupContext, tools: [] })) finalEvents.push(event);
    expect(finalEvents.some((event) => event.type === "tool_call")).toBe(false);
    expect(finalEvents.find((event) => event.type === "completed")).toMatchObject({ type: "completed", model: "local-acceptance-simulator" });
  });

  it("rejects unrelated prompts and never generates images", async () => {
    const meta = createAcceptanceSimulatorMeta();
    await expect(meta.plan("Crea un shooter espacial")).rejects.toThrow("acceptance_simulator_only_supports_digging_demo");
    await expect(meta.generateImage("un sprite")).rejects.toThrow("acceptance_simulator_image_generation_blocked");
  });
});
