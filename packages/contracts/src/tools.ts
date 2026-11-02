import { z } from "zod";

export const SANDBOX_FILE_MAX_BYTES = 1_048_576;
export const SANDBOX_FILE_OUTPUT_MAX_BYTES = 1_500_000;
export const SANDBOX_COMMAND_OUTPUT_MAX_BYTES = 64_000;
export const SANDBOX_LIST_MAX_ENTRIES = 32;
export const SANDBOX_DEV_SERVER_PORT = 4173;

const workspacePath = z.string().min(1).max(512).refine((value) => {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." &&
    ![...part].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
}, "Path must stay within the workspace");

export const SandboxReadFileInputSchema = z.object({ path: workspacePath }).strict();
export const SandboxListFilesInputSchema = z.object({
  path: z.string().max(512).default("").refine((value) => value === "" || workspacePath.safeParse(value).success),
}).strict();
export const SandboxWriteFileInputSchema = z.object({ path: workspacePath, content: z.string() }).strict()
  .refine((value) => new TextEncoder().encode(value.content).byteLength <= SANDBOX_FILE_MAX_BYTES, "File is too large");

const packageName = /^(?:@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const SandboxDependencySchema = z.object({
  name: z.string().min(1).max(214).regex(packageName),
  version: z.string().max(128).regex(exactVersion),
}).strict();
export const SandboxInstallDependenciesInputSchema = z.object({
  packages: z.array(SandboxDependencySchema).min(1).max(32),
}).strict().refine(({ packages }) => new Set(packages.map(({ name }) => name)).size === packages.length, "Package names must be unique");

export const SandboxRunCommandInputSchema = z.object({
  command: z.literal("npm"),
  args: z.array(z.string().min(1).max(1024)).min(1).max(32),
  cwd: z.string().max(512).default(""),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
}).strict();

export const SandboxStartDevServerInputSchema = z.object({}).strict();
export const SandboxReadLogsInputSchema = z.object({}).strict();

export type SandboxReadFileInput = z.infer<typeof SandboxReadFileInputSchema>;
export type SandboxListFilesInput = z.infer<typeof SandboxListFilesInputSchema>;
export type SandboxWriteFileInput = z.infer<typeof SandboxWriteFileInputSchema>;
export type SandboxDependency = z.infer<typeof SandboxDependencySchema>;
export type SandboxInstallDependenciesInput = z.infer<typeof SandboxInstallDependenciesInputSchema>;
export type SandboxRunCommandInput = z.input<typeof SandboxRunCommandInputSchema>;

export type SandboxFileEntry = Readonly<{ name: string; type: "file" | "directory"; size: number }>;
export type SandboxToolCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}>;
export type SandboxDevServerState = Readonly<{
  status: "stopped" | "starting" | "ready" | "failed";
  port: number | null;
  leaseExpiresAt: string | null;
}>;
export type SandboxDevServerLogs = Readonly<SandboxDevServerState & { stdout: string; stderr: string }>;

export function validateSandboxNpmArgs(args: readonly string[]): string[] {
  const [subcommand, script, ...rest] = args;
  if (subcommand === "--version" && args.length === 1) return ["--version"];
  if (subcommand === "test" && args.length === 1) return ["test"];
  if (subcommand !== "run" || !script || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(script)) {
    throw new Error("sandbox_command_not_allowed");
  }
  if (rest.length === 0) return ["run", script];
  if (rest[0] !== "--" || rest.length > 9 || rest.slice(1).some((part) =>
    !/^[A-Za-z0-9][A-Za-z0-9._:=,@+/-]{0,127}$/.test(part) || part.startsWith("--shell") || part.includes(".."))) {
    throw new Error("sandbox_command_not_allowed");
  }
  return ["run", script, "--", ...rest.slice(1)];
}
