import { describe, expect, it } from "vitest";
import { GAME_SPEC_PATH } from "../../apps/worker/src/pipelines/game-spec-path";
import { prepareAgentToolCalls } from "../../apps/worker/src/agent/tools";

describe("worker-owned GameSpec path", () => {
  it("blocks model writes to the normalized GameSpec while allowing Phaser runtime config", () => {
    const protectedWrite = {
      type: "tool_call",
      callId: "spec-write",
      name: "write_file",
      arguments: { path: GAME_SPEC_PATH, content: "{}" },
    };
    expect(() => prepareAgentToolCalls([protectedWrite] as never)).toThrow("agent_reserved_path_blocked");

    const runtimeWrite = {
      ...protectedWrite,
      callId: "runtime-write",
      arguments: { path: "src/game/project-spec.json", content: '{"mode":"digging"}' },
    };
    expect(prepareAgentToolCalls([runtimeWrite] as never)).toHaveLength(1);
  });
});
