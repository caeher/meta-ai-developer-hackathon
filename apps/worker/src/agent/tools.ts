import { createHash } from "node:crypto";
import {
  EditSpriteInputJsonSchema,
  EditSpriteInputSchema,
  EditSpriteResultSchema,
  AssetToolCardSchema,
  CreateTilesetInputSchema,
  CreateTilesetInputJsonSchema,
  CreateTilesetResultSchema,
  CreateTilemapInputSchema,
  CreateTilemapInputJsonSchema,
  CreateTilemapResultSchema,
  PackSpritesheetInputSchema,
  PackSpritesheetInputJsonSchema,
  PackSpritesheetResultSchema,
  DefineAnimationInputSchema,
  DefineAnimationInputJsonSchema,
  DefineAnimationResultSchema,
  ImageGenerationBriefSchema,
  GeneratedImageToolResultSchema,
  InspectAssetInputSchema,
  MakeTransparentInputSchema,
  MakeTransparentInputJsonSchema,
  MakeTransparentResultSchema,
  CreateIssuePlanInputSchema,
  CreateIssuePlanInputJsonSchema,
  CreateIssuePlanResultSchema,
  RunIssueAgentsInputSchema,
  RunIssueAgentsInputJsonSchema,
  RunIssueAgentsResultSchema,
  InspectAssetInputJsonSchema,
  InspectAssetResultSchema,
  SandboxInstallDependenciesInputSchema,
  SandboxListFilesInputSchema,
  SandboxReadFileInputSchema,
  SandboxReadLogsInputSchema,
  SandboxRunCommandInputSchema,
  SandboxStartDevServerInputSchema,
  SandboxWriteFileInputSchema,
  type MetaCodeEvent,
  type AssetToolCard,
} from "@meta-game/contracts";
import type { MetaToolDefinition } from "@meta-game/meta";
import type { SandboxControllerClient } from "@meta-game/sandbox";
import { isSensitiveWorkspacePath, redactSensitiveText, sensitiveInputReason } from "./safety";
import { buildIssuePlanFiles, issuePlanResult } from "./issue-plan";
import { GAME_SPEC_PATH } from "../pipelines/game-spec-path";

export type AgentSandbox = Pick<
  SandboxControllerClient,
  "create" | "inspect" | "readFile" | "readBinaryFile" | "writeFile" | "writeBinaryFile" | "deleteFile" | "listFiles" | "installDependencies" | "runCommand" | "startDevServer" | "readLogs" | "verifyGameInteraction"
>;

type ToolDefinition = MetaToolDefinition & Readonly<{ summary(args: Record<string, unknown>): string }>;

const definitions: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the current game workspace. Secret and environment files are blocked.",
    inputSchema: SandboxReadFileInputSchema,
    summary: (args) => `Leer ${String(args.path)}`,
  },
  {
    name: "write_file",
    description: "Atomically write a UTF-8 text file inside the current game workspace.",
    inputSchema: SandboxWriteFileInputSchema,
    summary: (args) => `Escribir ${String(args.path)} (${Buffer.byteLength(String(args.content), "utf8")} bytes)`,
  },
  {
    name: "list_files",
    description: "List direct children of a directory inside the current game workspace.",
    inputSchema: SandboxListFilesInputSchema,
    summary: (args) => `Listar ${String(args.path || ".")}`,
  },
  {
    name: "install_dependencies",
    description: "Install exact npm package versions through the restricted registry proxy without lifecycle scripts.",
    inputSchema: SandboxInstallDependenciesInputSchema,
    summary: (args) => `Instalar ${((args.packages as Array<{ name: string; version: string }>) ?? []).map(({ name, version }) => `${name}@${version}`).join(", ")}`,
  },
  {
    name: "run_command",
    description: "Run an allowed npm test or npm run script inside the isolated project sandbox. No shell or host command is available.",
    inputSchema: SandboxRunCommandInputSchema,
    summary: (args) => `Ejecutar npm ${(args.args as string[]).join(" ")}`,
  },
  {
    name: "start_dev_server",
    description: "Start the fixed Vite development server on the sandbox's configured port.",
    inputSchema: SandboxStartDevServerInputSchema,
    summary: () => "Iniciar la preview privada",
  },
  {
    name: "read_logs",
    description: "Read bounded logs from the sandbox's fixed development server.",
    inputSchema: SandboxReadLogsInputSchema,
    summary: () => "Leer logs del servidor de desarrollo",
  },
  {
    name: "generate_image",
    description: "Generate one original game image with Meta, validate and normalize it, store private provenance, and register it for Phaser loading.",
    inputSchema: ImageGenerationBriefSchema,
    summary: (args) => `Generar asset ${String(args.assetType)} y validarlo para Phaser`,
  },
  {
    name: "edit_sprite",
    description: "Create a new sprite by editing the exact private same-project sprite assetId supplied. Keeps the source unchanged, records derivation, and requires live preview review.",
    inputSchema: EditSpriteInputSchema,
    inputJsonSchema: EditSpriteInputJsonSchema as unknown as Record<string, unknown>,
    summary: () => "Editar el sprite indicado y registrar su procedencia",
  },
  {
    name: "create_tileset",
    description: "Pack validated same-project square PNG frames into a deterministic Phaser 3.90 row-major tileset with private metadata, stable local indices, collision flags, and terrain tags. This tool does not generate or modify artwork.",
    inputSchema: CreateTilesetInputSchema,
    inputJsonSchema: CreateTilesetInputJsonSchema as unknown as Record<string, unknown>,
    summary: (args) => `Empaquetar ${Array.isArray(args.tiles) ? args.tiles.length : 0} tiles en ${String(args.name)}`,
  },
  {
    name: "create_tilemap",
    description: "Create a Phaser 3.90 Tiled JSON level from sparse named cells and layers. Uses a validated same-project generated tileset, preserves layer order and visibility, and applies collision only to selected layers and tiles marked collides.",
    inputSchema: CreateTilemapInputSchema,
    inputJsonSchema: CreateTilemapInputJsonSchema as unknown as Record<string, unknown>,
    summary: (args) => `Crear mapa ${String(args.name)} (${String(args.width)}×${String(args.height)})`,
  },
  {
    name: "pack_spritesheet",
    description: "Extract approved frames from private same-project generated PNG assets, pack them in input order without rotation, trim, or scaling, and write a deterministic Phaser 3.90 JSON Hash atlas with source provenance.",
    inputSchema: PackSpritesheetInputSchema,
    inputJsonSchema: PackSpritesheetInputJsonSchema as unknown as Record<string, unknown>,
    summary: (args) => "Empaquetar " + (Array.isArray(args.frames) ? args.frames.length : 0) + " frames en " + String(args.name),
  },
  {
    name: "define_animation",
    description: "Define versioned Phaser 3.90 animations using explicit frame names from a private same-project atlas. Validates the atlas hash and frames, then stores an immutable manifest; it never generates animation code or artwork.",
    inputSchema: DefineAnimationInputSchema,
    inputJsonSchema: DefineAnimationInputJsonSchema as unknown as Record<string, unknown>,
    summary: (args) => `Definir ${Array.isArray(args.animations) ? args.animations.length : 0} animaciones desde atlas ${String(args.atlasAssetId)}`,
  },
  {
    name: "make_transparent",
    description: "Create a NEW transparent PNG from an exact private same-project assetId/frame. Local deterministic background removal (corner-flood, color-key or alpha-cleanup); never calls the image provider, never modifies the source, and registers the result so pack_spritesheet can pack it into a Phaser atlas.",
    inputSchema: MakeTransparentInputSchema,
    inputJsonSchema: MakeTransparentInputJsonSchema as unknown as Record<string, unknown>,
    summary: (args) => `Hacer transparente el asset ${String(args.sourceAssetId)} (${String(args.mode ?? "corner-flood")})`,
  },
  {
    name: "create_issue_plan",
    description: "Write a development plan as Markdown issue files inside the workspace. kind=sprites writes docs/issues/sprites/*.md (one issue per sprite/atlas/animation with exact generate_image -> make_transparent -> inspect_asset -> pack_spritesheet -> define_animation instructions); kind=game writes docs/issues/game/*.md (one issue per code feature, consuming the sprite summary); kind=general writes docs/issues/*.md. Use sprites first, then game, each before its run_issue_agents call.",
    inputSchema: CreateIssuePlanInputSchema,
    inputJsonSchema: CreateIssuePlanInputJsonSchema as unknown as Record<string, unknown>,
    summary: (args) => `Crear plan ${String(args.kind ?? "general")} en issues Markdown: ${String(args.title)} (${Array.isArray(args.issues) ? args.issues.length : 0} issues)`,
  },
  {
    name: "run_issue_agents",
    description: "Orchestrate one specialized sub-agent per issue, sequentially (single workspace writer), in dependency order. kind=sprites sub-agents can only use asset tools (generate_image, edit_sprite, make_transparent, inspect_asset, pack_spritesheet, create_tileset, create_tilemap, define_animation, read_file, list_files); kind=game sub-agents can only use code tools plus inspect_asset/read-only asset checks; kind=general keeps the full non-orchestration set. Each sub-agent implements only its issue, the issue Markdown status is updated, and progress/tool calls are streamed to the web UI. Sub-agents cannot start nested orchestration. Running kind=game requires the sprites phase to have completed when a sprite plan exists.",
    inputSchema: RunIssueAgentsInputSchema,
    inputJsonSchema: RunIssueAgentsInputJsonSchema as unknown as Record<string, unknown>,
    summary: (args) => `Orquestar sub-agentes ${String(args.kind ?? "general")} para ${Array.isArray(args.issues) ? args.issues.length : 0} issue(s)`,
  },
  {
    name: "inspect_asset",
    description: "Read-only inspection of a private image or Phaser asset descriptor. Checks bytes, checksums, atlas frames and pivots, tileset/map bounds, and animation frame names. It never writes or fetches URLs.",
    inputSchema: InspectAssetInputSchema,
    inputJsonSchema: InspectAssetInputJsonSchema as unknown as Record<string, unknown>,
    summary: (args) => `Inspeccionar asset ${String(args.assetId ?? args.workspacePath)}`,
  },
];

const byName = new Map(definitions.map((definition) => [definition.name, definition]));

/** Tools que puede usar cada sub-agente segun la fase. Nunca incluye orquestacion anidada. */
export const SPRITE_SUBAGENT_TOOLS = ["generate_image", "edit_sprite", "make_transparent", "inspect_asset", "pack_spritesheet", "create_tileset", "create_tilemap", "define_animation", "read_file", "list_files"] as const;
export const GAME_SUBAGENT_TOOLS = ["read_file", "write_file", "list_files", "install_dependencies", "run_command", "start_dev_server", "read_logs", "inspect_asset"] as const;
export function subagentToolNames(kind: "sprites" | "game" | "general"): string[] {
  if (kind === "sprites") return [...SPRITE_SUBAGENT_TOOLS];
  if (kind === "game") return [...GAME_SUBAGENT_TOOLS];
  return definitions.filter((d) => d.name !== "run_issue_agents" && d.name !== "create_issue_plan").map((d) => d.name);
}

export const agentToolDefinitions: MetaToolDefinition[] = definitions.map(({ name, description, inputSchema, inputJsonSchema }) => ({
  name,
  description,
  inputSchema,
  ...(inputJsonSchema ? { inputJsonSchema } : {}),
}));

export type PreparedAgentToolCall = Readonly<{
  callId: string;
  name: string;
  args: Record<string, unknown>;
  argsHash: string;
  summary: string;
}>;

export function prepareAgentToolCalls(calls: readonly Extract<MetaCodeEvent, { type: "tool_call" }>[]): PreparedAgentToolCall[] {
  const seen = new Set<string>();
  return calls.map((call) => {
    const definition = byName.get(call.name);
    if (!definition) throw new Error("agent_unknown_tool");
    if (seen.has(call.callId)) throw new Error("agent_duplicate_call_id");
    seen.add(call.callId);
    const parsed = definition.inputSchema.safeParse(call.arguments);
    if (!parsed.success || !isPlainRecord(parsed.data)) throw new Error("agent_invalid_tool_arguments");
    const args = parsed.data;
    if (sensitiveInputReason(JSON.stringify(args))) throw new Error("agent_sensitive_content_blocked");
    const path = typeof args.path === "string" ? args.path : undefined;
    if (path && isSensitiveWorkspacePath(path)) throw new Error("agent_sensitive_path_blocked");
    if (call.name === "write_file" && path === GAME_SPEC_PATH) throw new Error("agent_reserved_path_blocked");
    const normalized = canonicalJson(args);
    return {
      callId: call.callId,
      name: call.name,
      args,
      argsHash: createHash("sha256").update(normalized).digest("hex"),
      summary: redactSensitiveText(definition.summary(args)).slice(0, 240),
    };
  });
}

const assetResultSchemas = {
  generate_image: GeneratedImageToolResultSchema,
  edit_sprite: EditSpriteResultSchema,
  inspect_asset: InspectAssetResultSchema,
  create_tileset: CreateTilesetResultSchema,
  create_tilemap: CreateTilemapResultSchema,
  pack_spritesheet: PackSpritesheetResultSchema,
  define_animation: DefineAnimationResultSchema,
  make_transparent: MakeTransparentResultSchema,
  create_issue_plan: CreateIssuePlanResultSchema,
  run_issue_agents: RunIssueAgentsResultSchema,
} as const;

/** Validate asset tool output before it becomes durable or enters Meta's function_call_output replay. */
export function validateAgentToolResult(toolName: string, value: unknown): unknown {
  if (!(toolName in assetResultSchemas)) return value;
  const schema = assetResultSchemas[toolName as keyof typeof assetResultSchemas];
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("agent_invalid_tool_result");
  return parsed.data;
}

export function encodeAgentToolResult(toolName: string, value: unknown): { json: string; value: unknown } {
  if (!(toolName in assetResultSchemas)) return compactToolResult(value);
  const schema = assetResultSchemas[toolName as keyof typeof assetResultSchemas];
  const validated = validateAgentToolResult(toolName, value);
  const sanitized = sanitizeAssetResult(validated);
  const safeResult = schema.safeParse(sanitized);
  if (!safeResult.success) throw new Error("agent_invalid_tool_result");
  const json = JSON.stringify(safeResult.data);
  if (Buffer.byteLength(json, "utf8") > 65_536) throw new Error("agent_tool_result_too_large");
  return { json, value: safeResult.data };
}

export function createAssetToolCard(callId: string, toolName: string, result: unknown): AssetToolCard | undefined {
  const id = (assetId: string, role: AssetToolCard["assets"][number]["role"], sha256?: string, previewable = false) => ({
    assetId,
    role,
    ...(sha256 ? { sha256 } : {}),
    previewable,
  });
  const base = (input: Omit<AssetToolCard, "callId" | "toolName">): AssetToolCard =>
    AssetToolCardSchema.parse({ callId, toolName, ...input });
  switch (toolName) {
    case "generate_image": {
      const value = GeneratedImageToolResultSchema.parse(result);
      return base({
        status: "succeeded", title: "Imagen generada", summary: `${value.frameCount} frame(s); PNG y manifiesto guardados.`,
        assetType: value.assetType, assets: [id(value.assetId, "image", value.sha256, true), id(value.contactSheetAssetId, "contact-sheet")],
        previewAssetId: value.assetId, frameCount: value.frameCount, verificationStatus: "needs_review",
        verificationSummary: "Dimensiones, frames y checksum validados; queda pendiente la revisión visual en el juego.",
      });
    }
    case "edit_sprite": {
      const value = EditSpriteResultSchema.parse(result);
      return base({
        status: "succeeded", title: "Sprite editado", summary: "Se creó un sprite nuevo; el original se conserva.",
        assetType: "sprite", assets: [id(value.assetId, "image", value.sha256, true), id(value.sourceAssetId, "source", value.sourceSha256)],
        previewAssetId: value.assetId, frameCount: 1, verificationStatus: "needs_review",
        verificationSummary: "Bytes y procedencia validados; queda pendiente la revisión visual en el juego.",
      });
    }
    case "make_transparent": {
      const value = MakeTransparentResultSchema.parse(result);
      return base({
        status: "succeeded", title: "Transparencia aplicada", summary: `${value.removedPixels} p?xeles de fondo eliminados (${value.mode}); asset nuevo listo para atlas.`,
        assetType: "sprite", assets: [id(value.assetId, "image", value.sha256, true), id(value.sourceAssetId, "source", value.sourceSha256)],
        previewAssetId: value.assetId, frameCount: 1, verificationStatus: "needs_review",
        verificationSummary: "Alpha y dimensiones validados; queda pendiente la revisi?n visual en el juego.",
      });
    }
    case "inspect_asset": {
      const value = InspectAssetResultSchema.parse(result);
      const previewable = value.kind === "image" && value.assetId !== undefined;
      return base({
        status: "succeeded", title: "Inspección de asset", summary: `${value.findings.length} hallazgo(s); tipo ${value.kind}.`,
        assetType: "inspection",
        assets: value.assetId ? [id(value.assetId, "source", value.sha256, previewable)] : [],
        ...(previewable && value.assetId ? { previewAssetId: value.assetId } : {}),
        ...(value.frameCount === undefined ? {} : { frameCount: value.frameCount }),
        verificationStatus: value.status === "valid" ? "passed" : value.status === "invalid" ? "failed" : "needs_review",
        verificationSummary: value.status === "valid" ? "Las verificaciones seleccionadas pasaron." : value.status === "invalid" ? "La inspección encontró validaciones fallidas." : "La inspección requiere revisión.",
      });
    }
    case "create_tileset": {
      const value = CreateTilesetResultSchema.parse(result);
      const collidingTiles = value.tiles.filter((tile) => tile.collides).length;
      return base({
        status: "succeeded", title: "Tileset creado", summary: `${value.tiles.length} tiles; ${collidingTiles} con colisión.`,
        assetType: "tileset", assets: [id(value.tilesetAssetId, "tileset", value.sha256, true)],
        previewAssetId: value.tilesetAssetId, frameCount: value.tiles.length, verificationStatus: "passed",
        verificationSummary: "Índices, dimensiones, colisiones y hash del tileset validados.",
      });
    }
    case "create_tilemap": {
      const value = CreateTilemapResultSchema.parse(result);
      return base({
        status: "succeeded", title: "Tilemap creado", summary: `${value.layerNames.length} capas; ${value.cellCount} celdas.`,
        assetType: "tilemap", assets: [id(value.tilemapAssetId, "tilemap", value.sha256)],
        frameCount: value.cellCount, layerCount: value.layerNames.length, verificationStatus: "passed",
        verificationSummary: "GIDs, límites, orden de capas y nombres de colisión validados.",
      });
    }
    case "pack_spritesheet": {
      const value = PackSpritesheetResultSchema.parse(result);
      return base({
        status: "succeeded", title: "Spritesheet empaquetado", summary: `${value.frames.length} frames en atlas Phaser.`,
        assetType: "spritesheet", assets: [id(value.textureAssetId, "texture", undefined, true), id(value.atlasAssetId, "atlas", value.sha256)],
        previewAssetId: value.textureAssetId, frameCount: value.frames.length, verificationStatus: "passed",
        verificationSummary: "Rectángulos dentro del atlas, sin solapes y con procedencia validada.",
      });
    }
    case "define_animation": {
      const value = DefineAnimationResultSchema.parse(result);
      const frameCount = value.animations.reduce((total, animation) => total + animation.frameNames.length, 0);
      return base({
        status: "succeeded", title: "Animación definida", summary: `${value.animations.length} animación(es); ${frameCount} referencias a frames.`,
        assetType: "animation", assets: [id(value.animationManifestAssetId, "animation", value.sha256), id(value.atlasAssetId, "atlas")],
        frameCount, verificationStatus: "passed", verificationSummary: "Atlas, nombres de frame y parámetros de reproducción validados.",
      });
    }
    default:
      return undefined;
  }
}

export function createFailedAssetToolCard(callId: string, toolName: string, errorCode: string): AssetToolCard | undefined {
  const names: Record<string, { title: string; assetType: AssetToolCard["assetType"] }> = {
    generate_image: { title: "Generar imagen", assetType: "sprite" },
    edit_sprite: { title: "Editar sprite", assetType: "sprite" },
    make_transparent: { title: "Hacer transparente", assetType: "sprite" },
    inspect_asset: { title: "Inspeccionar asset", assetType: "inspection" },
    create_tileset: { title: "Crear tileset", assetType: "tileset" },
    create_tilemap: { title: "Crear tilemap", assetType: "tilemap" },
    pack_spritesheet: { title: "Empaquetar spritesheet", assetType: "spritesheet" },
    define_animation: { title: "Definir animación", assetType: "animation" },
  };
  const entry = names[toolName];
  if (!entry || !/^[a-z][a-z0-9_]{0,99}$/.test(errorCode)) return undefined;
  return AssetToolCardSchema.parse({
    callId, toolName, status: "failed", title: entry.title, summary: "La herramienta no pudo completar este asset.",
    assetType: entry.assetType, assets: [], verificationStatus: "failed",
    verificationSummary: "Revisa el código de error antes de volver a intentarlo.", errorCode,
  });
}

export async function executeAgentTool(
  sandbox: AgentSandbox,
  projectId: string,
  call: PreparedAgentToolCall,
  signal: AbortSignal,
): Promise<unknown> {
  const args = call.args;
  switch (call.name) {
    case "create_issue_plan": {
      const input = CreateIssuePlanInputSchema.parse(args);
      const planId = `plan-${call.callId}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 80);
      const files = buildIssuePlanFiles(input, planId);
      for (const file of files) {
        const written = await sandbox.writeFile(projectId, file.path, file.content, signal);
        if (written.bytesWritten !== Buffer.byteLength(file.content, "utf8")) throw new Error("issue_plan_write_failed");
      }
      return issuePlanResult(input, planId);
    }
    case "run_issue_agents":
      // Executed by the orchestrator, which owns Meta and the sub-agent loop.
      throw new Error("agent_orchestration_requires_orchestrator");
    case "read_file": {
      const result = await sandbox.readFile(projectId, String(args.path), signal);
      const content = redactSensitiveText(result.content);
      return { path: result.path, content: content.slice(0, 6_000), truncated: content.length > 6_000 };
    }
    case "write_file": {
      const result = await sandbox.writeFile(projectId, String(args.path), String(args.content), signal);
      return { path: result.path, bytesWritten: result.bytesWritten };
    }
    case "list_files": {
      const path = String(args.path ?? "");
      const result = await sandbox.listFiles(projectId, path, signal);
      return {
        path: result.path,
        files: result.files.filter((file) => !isSensitiveWorkspacePath(`${path ? `${path}/` : ""}${file.name}`)),
      };
    }
    case "install_dependencies": {
      const result = await sandbox.installDependencies(projectId, args as never, signal);
      return compactCommandResult(result);
    }
    case "run_command": {
      const result = await sandbox.runCommand(projectId, args as never, signal);
      return compactCommandResult(result);
    }
    case "start_dev_server":
      return await sandbox.startDevServer(projectId, signal);
    case "read_logs": {
      const result = await sandbox.readLogs(projectId, signal);
      return {
        status: result.status,
        port: result.port,
        leaseExpiresAt: result.leaseExpiresAt,
        stdout: redactSensitiveText(result.stdout).slice(-4_000),
        stderr: redactSensitiveText(result.stderr).slice(-4_000),
      };
    }
    default:
      throw new Error("agent_unknown_tool");
  }
}

export function compactToolResult(value: unknown): { json: string; value: unknown } {
  const safe = sanitizeValue(value);
  let json = JSON.stringify(safe);
  if (Buffer.byteLength(json, "utf8") > 24_000) {
    json = JSON.stringify({ truncated: true, summary: "Tool output exceeded the context limit." });
    return { json, value: JSON.parse(json) as unknown };
  }
  return { json, value: JSON.parse(json) as unknown };
}

function compactCommandResult(result: { stdout: string; stderr: string; exitCode: number; durationMs: number; truncated: boolean }) {
  return {
    stdout: redactSensitiveText(result.stdout).slice(-4_000),
    stderr: redactSensitiveText(result.stderr).slice(-4_000),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated || result.stdout.length > 4_000 || result.stderr.length > 4_000,
  };
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested output omitted]";
  if (typeof value === "string") return redactSensitiveText(value).slice(0, 12_000);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitizeValue(item, depth + 1));
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key.slice(0, 120), sanitizeValue(item, depth + 1)]));
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  return "[unsupported output omitted]";
}

function sanitizeAssetResult(value: unknown): unknown {
  if (typeof value === "string") {
    // IDs and ID-derived workspace paths are validated by each strict tool result schema.
    // Keep them intact; the general output redactor treats UUIDs as phone-like strings.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ||
        /^[a-f0-9]{64}$/.test(value) ||
        /^generated-[0-9a-f-]{36}$/.test(value) ||
        value === "public/assets/generated/manifest.json" ||
        /^assets\/generated\/(?:[0-9a-f-]{36}\.png|(?:tilesets|tilemaps|atlases|animations)\/[0-9a-f-]{36}\.(?:png|json))$/.test(value) ||
        /^docs\/issues\/(?:sprites\/|game\/)?(?:INDEX\.md|\d{2}-[a-z][a-z0-9-]{0,47}\.md)$/.test(value) || /^plan-[A-Za-z0-9._:-]{1,74}$/.test(value)) {
      return value;
    }
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) return value.map(sanitizeAssetResult);
  if (isPlainRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeAssetResult(item)]));
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
