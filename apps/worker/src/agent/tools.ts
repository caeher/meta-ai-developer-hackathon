import { createHash } from "node:crypto";
import {
  EditSpriteInputJsonSchema,
  EditSpriteInputSchema,
  CreateTilesetInputSchema,
  CreateTilesetInputJsonSchema,
  CreateTilemapInputSchema,
  CreateTilemapInputJsonSchema,
  ImageGenerationBriefSchema,
  InspectAssetInputSchema,
  InspectAssetInputJsonSchema,
  SandboxInstallDependenciesInputSchema,
  SandboxListFilesInputSchema,
  SandboxReadFileInputSchema,
  SandboxReadLogsInputSchema,
  SandboxRunCommandInputSchema,
  SandboxStartDevServerInputSchema,
  SandboxWriteFileInputSchema,
  type MetaCodeEvent,
} from "@meta-game/contracts";
import type { MetaToolDefinition } from "@meta-game/meta";
import type { SandboxControllerClient } from "@meta-game/sandbox";
import { isSensitiveWorkspacePath, redactSensitiveText, sensitiveInputReason } from "./safety";

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
    name: "inspect_asset",
    description: "Read-only inspection of a private image or Phaser asset descriptor. Checks bytes, checksums, atlas frames and pivots, tileset/map bounds, and animation frame names. It never writes or fetches URLs.",
    inputSchema: InspectAssetInputSchema,
    inputJsonSchema: InspectAssetInputJsonSchema as unknown as Record<string, unknown>,
    summary: (args) => `Inspeccionar asset ${String(args.assetId ?? args.workspacePath)}`,
  },
];

const byName = new Map(definitions.map((definition) => [definition.name, definition]));

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

export async function executeAgentTool(
  sandbox: AgentSandbox,
  projectId: string,
  call: PreparedAgentToolCall,
  signal: AbortSignal,
): Promise<unknown> {
  const args = call.args;
  switch (call.name) {
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
