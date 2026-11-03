import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  CreateIssuePlanInputSchema,
  EditorProgressSchema,
  MakeTransparentInputSchema,
  RunIssueAgentsInputSchema,
  RunStreamEventSchema,
} from "@meta-game/contracts";
import { prepareAgentToolCalls, executeAgentTool, subagentToolNames, type AgentSandbox } from "../../apps/worker/src/agent/tools";
import { buildIssuePlanFiles, updateIssueFileStatus } from "../../apps/worker/src/agent/issue-plan";
import { applyTransparencyToPng } from "../../apps/worker/src/assets/transparency";

async function solidPng(width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { raw[i * 4] = rgb.r; raw[i * 4 + 1] = rgb.g; raw[i * 4 + 2] = rgb.b; raw[i * 4 + 3] = 255; }
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) {
    const o = (y * width + x) * 4; raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30; raw[o + 3] = 255;
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

describe("new agent tool contracts", () => {
  it("accepts make_transparent, create_issue_plan and run_issue_agents tool calls", () => {
    const calls = prepareAgentToolCalls([
      { type: "tool_call", callId: "c1", name: "make_transparent", arguments: { sourceAssetId: "00000000-0000-4000-8000-000000000201", mode: "corner-flood", tolerance: 12 } },
      { type: "tool_call", callId: "c2", name: "create_issue_plan", arguments: { title: "Juego", issues: [{ slug: "core", title: "Core", objective: "Base jugable", tasks: ["Crear escena"] }] } },
      { type: "tool_call", callId: "c3", name: "run_issue_agents", arguments: { issues: [{ issueId: "01-core", title: "Core", instructions: "Implementa la escena" }] } },
    ] as never);
    expect(calls.map((c) => c.name)).toEqual(["make_transparent", "create_issue_plan", "run_issue_agents"]);
    expect(MakeTransparentInputSchema.parse({ sourceAssetId: "00000000-0000-4000-8000-000000000201" }).mode).toBe("corner-flood");
    expect(RunIssueAgentsInputSchema.parse({ issues: [{ issueId: "01-core", title: "Core", instructions: "x" }] }).issues).toHaveLength(1);
    expect(CreateIssuePlanInputSchema.parse({ title: "J", issues: [{ slug: "core", title: "Core", objective: "B", tasks: ["t"] }] }).issues[0]?.slug).toBe("core");
  });
  it("rejects issue plan with duplicate slugs and run_issue_agents with duplicate ids", () => {
    expect(() => prepareAgentToolCalls([{ type: "tool_call", callId: "x", name: "create_issue_plan", arguments: { title: "J", issues: [{ slug: "a", title: "A", objective: "o", tasks: ["t"] }, { slug: "a", title: "B", objective: "o", tasks: ["t"] }] } }] as never)).toThrow();
    expect(RunIssueAgentsInputSchema.safeParse({ issues: [{ issueId: "01-a", title: "A", instructions: "x" }, { issueId: "01-a", title: "B", instructions: "y" }] }).success).toBe(false);
  });
});

describe("issue plan markdown", () => {
  const input = CreateIssuePlanInputSchema.parse({
    title: "Plataformas",
    issues: [
      { slug: "core-loop", title: "Core loop", objective: "Movimiento", tasks: ["Crear jugador", "Colisiones"], dependsOn: [], acceptance: ["Se mueve"] },
      { slug: "enemies", title: "Enemigos", objective: "IA simple", tasks: ["Patrulla"], dependsOn: ["core-loop"], acceptance: [] },
    ],
  });
  it("builds an index and one markdown file per issue with dependencies", () => {
    const files = buildIssuePlanFiles(input, "plan-1");
    expect(files.map((f) => f.path)).toEqual(["docs/issues/INDEX.md", "docs/issues/01-core-loop.md", "docs/issues/02-enemies.md"]);
    expect(files[0]?.content).toContain("01-core-loop");
    expect(files[2]?.content).toContain("01-core-loop");
    expect(files[1]?.content).toContain("- [ ] Crear jugador");
    expect(files[1]?.content).toContain("Estado: pending");
  });
  it("updates only the status line of an issue file", () => {
    const files = buildIssuePlanFiles(input, "plan-1");
    const updated = updateIssueFileStatus(files[1]!.content, "completed", "Hecho por sub-agente");
    expect(updated).toContain("Estado: completed");
    expect(updated).toContain("Hecho por sub-agente");
    expect(updated).toContain("Crear jugador");
  });
  it("create_issue_plan tool writes every markdown file through the sandbox", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const sandbox = { writeFile: vi.fn(async (_p: string, path: string, content: string) => { writes.push({ path, content }); return { path, bytesWritten: Buffer.byteLength(content) }; }) } as unknown as AgentSandbox;
    const [call] = prepareAgentToolCalls([{ type: "tool_call", callId: "p1", name: "create_issue_plan", arguments: { title: "J", issues: [{ slug: "core", title: "Core", objective: "Base", tasks: ["Escena"] }] } }] as never);
    const result = await executeAgentTool(sandbox, "proj", call!, new AbortController().signal) as { issues: Array<{ path: string }> };
    expect(writes.map((w) => w.path)).toContain("docs/issues/01-core.md");
    expect(result.issues[0]?.path).toBe("docs/issues/01-core.md");
  });
});

describe("transparency", () => {
  it("corner-flood removes the connected background and keeps the subject opaque", async () => {
    const png = await solidPng(4, 4, { r: 255, g: 255, b: 255 });
    const out = await applyTransparencyToPng(png, { mode: "corner-flood", tolerance: 10 });
    expect(out.width).toBe(4); expect(out.transparentPixels).toBe(true); expect(out.removedPixels).toBe(12);
    const { data } = await sharp(out.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    const center = (1 * 4 + 1) * 4; expect(data[center + 3]).toBe(255);
  });
  it("color-key removes an explicit color everywhere within tolerance", async () => {
    const png = await solidPng(4, 4, { r: 255, g: 255, b: 255 });
    const out = await applyTransparencyToPng(png, { mode: "color-key", color: "#ffffff", tolerance: 10 });
    expect(out.removedPixels).toBe(12);
  });
});

describe("web projection contracts", () => {
  it("EditorProgress carries issues and subagents, and stream events validate", () => {
    const progress = EditorProgressSchema.parse({
      status: "running", plan: [], steps: [], changedFiles: [], assetCards: [],
      issues: [{ id: "01-core", title: "Core", path: "docs/issues/01-core.md", status: "running", dependsOn: [] }],
      subagents: [{ issueId: "01-core", title: "Core", status: "running" }],
      verification: { status: "pending" },
    });
    expect(progress.issues[0]?.status).toBe("running");
    expect(progress.subagents[0]?.issueId).toBe("01-core");
    const base = { version: 1 as const, runId: "00000000-0000-4000-8000-000000000101", sequence: 3, createdAt: "2026-11-03T00:00:00.000Z" };
    expect(RunStreamEventSchema.parse({ ...base, type: "issue.plan", payload: { planId: "p1", title: "J", issues: progress.issues } }).type).toBe("issue.plan");
    expect(RunStreamEventSchema.parse({ ...base, type: "subagent.updated", payload: { issueId: "01-core", title: "Core", status: "succeeded", summary: "ok" } }).type).toBe("subagent.updated");
    expect(EditorProgressSchema.parse({ status: "queued", plan: [], steps: [], changedFiles: [], verification: { status: "pending" } }).issues).toEqual([]);
  });
});

describe("flujo agentico por fases (sprites -> juego)", () => {
  it("create_issue_plan kind=sprites escribe en docs/issues/sprites/ con instrucciones de spritesheet/atlas", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const sandbox = { writeFile: vi.fn(async (_p: string, path: string, content: string) => { writes.push({ path, content }); return { path, bytesWritten: Buffer.byteLength(content) }; }) } as unknown as AgentSandbox;
    const [call] = prepareAgentToolCalls([{ type: "tool_call", callId: "sp1", name: "create_issue_plan", arguments: { title: "Sprites", kind: "sprites", issues: [{ slug: "hero", title: "Heroe", objective: "Sprite jugable", tasks: ["Generar heroe"] }] } }] as never);
    const result = await executeAgentTool(sandbox, "proj", call!, new AbortController().signal) as { kind: string; indexPath: string; issues: Array<{ path: string; kind: string }> };
    expect(result.kind).toBe("sprites");
    expect(result.indexPath).toBe("docs/issues/sprites/INDEX.md");
    expect(result.issues[0]?.path).toBe("docs/issues/sprites/01-hero.md");
    const md = writes.find((w) => w.path === "docs/issues/sprites/01-hero.md")?.content ?? "";
    expect(md).toContain("Tipo: sprites");
    expect(md).toContain("generate_image");
    expect(md).toContain("pack_spritesheet");
    expect(md).toContain("define_animation");
    expect(md).toContain("make_transparent");
  });
  it("create_issue_plan kind=game escribe en docs/issues/game/ consumiendo el resumen de sprites", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const sandbox = { writeFile: vi.fn(async (_p: string, path: string, content: string) => { writes.push({ path, content }); return { path, bytesWritten: Buffer.byteLength(content) }; }) } as unknown as AgentSandbox;
    const [call] = prepareAgentToolCalls([{ type: "tool_call", callId: "gp1", name: "create_issue_plan", arguments: { title: "Juego", kind: "game", issues: [{ slug: "core", title: "Core", objective: "Loop", tasks: ["Escena"] }] } }] as never);
    const result = await executeAgentTool(sandbox, "proj", call!, new AbortController().signal) as { kind: string; issues: Array<{ path: string }> };
    expect(result.kind).toBe("game");
    expect(result.issues[0]?.path).toBe("docs/issues/game/01-core.md");
    const md = writes.find((w) => w.path === "docs/issues/game/01-core.md")?.content ?? "";
    expect(md).toContain("resumen de sprites");
    expect(md).toContain("Phaser 3.90");
  });
  it("los sub-agentes estan especializados: sprites sin codigo, juego sin generar imagenes", () => {
    expect(subagentToolNames("sprites")).toContain("pack_spritesheet");
    expect(subagentToolNames("sprites")).toContain("generate_image");
    expect(subagentToolNames("sprites")).not.toContain("write_file");
    expect(subagentToolNames("sprites")).not.toContain("run_issue_agents");
    expect(subagentToolNames("game")).toContain("write_file");
    expect(subagentToolNames("game")).not.toContain("generate_image");
    expect(subagentToolNames("game")).not.toContain("pack_spritesheet");
  });
  it("EditorProgress expone fases y tool calls del chat agentico", () => {
    const progress = EditorProgressSchema.parse({
      status: "running", plan: [], steps: [], changedFiles: [],
      phases: [{ phase: "sprites", status: "running", summary: "Creando atlas" }],
      toolCalls: [{ callId: "c1", toolName: "pack_spritesheet", title: "Empaquetar atlas", status: "running", phase: "sprites", issueId: "01-hero" }],
      verification: { status: "pending" },
    });
    expect(progress.phases[0]?.phase).toBe("sprites");
    expect(progress.toolCalls[0]?.toolName).toBe("pack_spritesheet");
    const base = { version: 1 as const, runId: "00000000-0000-4000-8000-000000000101", sequence: 4, createdAt: "2026-11-03T00:00:00.000Z" };
    expect(RunStreamEventSchema.parse({ ...base, type: "phase.updated", payload: { phase: "sprite-plan", status: "completed", summary: "ok" } }).type).toBe("phase.updated");
    expect(RunStreamEventSchema.parse({ ...base, type: "issue.plan", payload: { planId: "p1", title: "Sprites", kind: "sprites", issues: [{ id: "01-hero", title: "Heroe", path: "docs/issues/sprites/01-hero.md", kind: "sprites", status: "pending", dependsOn: [] }] } }).type).toBe("issue.plan");
  });
});
