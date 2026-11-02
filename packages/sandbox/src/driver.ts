export type SandboxLimits = Readonly<{
  cpu: number;
  memoryMb: number;
  diskMb: number;
  pids: number;
  commandTimeoutMs: number;
}>;

export type SandboxCreateSpec = Readonly<{
  sandboxId: string;
  projectId: string;
  uid: number;
  image: string;
  limits: SandboxLimits;
  egressAllowlist?: readonly string[];
}>;

export type SandboxRuntimeState = "created" | "running" | "stopped" | "missing";

export type SandboxInspection = Readonly<{
  sandboxId: string;
  state: SandboxRuntimeState;
  uid: number;
  limits: SandboxLimits;
}>;

export type SandboxExecResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated?: boolean;
}>;

export type SandboxExecOptions = Readonly<{
  stdin?: string;
  maxOutputBytes?: number;
}>;

export interface SandboxDriver {
  verifyHost(): Promise<void>;
  create(spec: SandboxCreateSpec): Promise<SandboxInspection>;
  inspect(sandboxId: string, projectId: string, uid: number): Promise<SandboxInspection>;
  stop(sandboxId: string, projectId: string, uid: number): Promise<void>;
  destroy(sandboxId: string, projectId: string, uid: number): Promise<void>;
  exec(sandboxId: string, projectId: string, uid: number, argv: readonly string[], cwd: string, timeoutMs: number, options?: SandboxExecOptions): Promise<SandboxExecResult>;
}

export class SandboxRuntimeError extends Error {
  constructor(public readonly code: string, message = code) {
    super(/^[a-z][a-z0-9_]{0,79}$/.test(code) ? message : "sandbox_runtime_failed");
    this.name = "SandboxRuntimeError";
  }
}

export function assertSandboxUid(uid: number): number {
  if (!Number.isSafeInteger(uid) || uid < 10_000 || uid > 59_999) throw new SandboxRuntimeError("invalid_sandbox_uid");
  return uid;
}

export function sandboxVolumeName(sandboxId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sandboxId)) throw new SandboxRuntimeError("invalid_sandbox_id");
  return `mg-workspace-${sandboxId}`;
}

export function sandboxContainerName(sandboxId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sandboxId)) throw new SandboxRuntimeError("invalid_sandbox_id");
  return `mg-sandbox-${sandboxId}`;
}

export function sandboxNetworkName(sandboxId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sandboxId)) throw new SandboxRuntimeError("invalid_sandbox_id");
  return `mg-sandbox-net-${sandboxId}`;
}

export function egressProxyContainerName(sandboxId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sandboxId)) throw new SandboxRuntimeError("invalid_sandbox_id");
  return `mg-egress-${sandboxId}`;
}

export function resolveWorkspaceCwd(cwd: string): string {
  if (cwd.length > 512 || cwd.includes("\0") || cwd.includes("\\") || cwd.startsWith("/")) {
    throw new SandboxRuntimeError("invalid_working_directory");
  }
  const parts = cwd.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".." || !/^[A-Za-z0-9._@+-]+$/.test(part))) {
    throw new SandboxRuntimeError("invalid_working_directory");
  }
  return parts.length ? `/workspace/${parts.join("/")}` : "/workspace";
}

export function validateSandboxArgv(argv: readonly string[]): string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64) throw new SandboxRuntimeError("invalid_argv");
  let size = 0;
  const result = argv.map((part) => {
    if (typeof part !== "string" || part.length > 4096 || part.includes("\0")) throw new SandboxRuntimeError("invalid_argv");
    size += Buffer.byteLength(part);
    return part;
  });
  if (size > 32_768 || !result[0] || result[0].startsWith("-")) throw new SandboxRuntimeError("invalid_argv");
  if (["sh", "ash", "bash", "/bin/sh", "/bin/ash", "/bin/bash"].includes(result[0])) {
    throw new SandboxRuntimeError("shell_command_not_allowed");
  }
  return result;
}
