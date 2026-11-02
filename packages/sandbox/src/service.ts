import type { SandboxRecord, SandboxState } from "@meta-game/db";
import type { SandboxEnvironment } from "@meta-game/config";
import {
  SANDBOX_COMMAND_OUTPUT_MAX_BYTES,
  SANDBOX_DEV_SERVER_PORT,
  SANDBOX_FILE_OUTPUT_MAX_BYTES,
  SANDBOX_LIST_MAX_ENTRIES,
  SandboxInstallDependenciesInputSchema,
  SandboxListFilesInputSchema,
  SandboxReadFileInputSchema,
  SandboxRunCommandInputSchema,
  SandboxWriteFileInputSchema,
  validateSandboxNpmArgs,
  type SandboxDevServerLogs,
  type SandboxDevServerState,
  type SandboxFileEntry,
  type SandboxInstallDependenciesInput,
  type SandboxRunCommandInput,
  type SandboxToolCommandResult,
} from "@meta-game/contracts";
import type { SandboxDriver, SandboxExecOptions, SandboxExecResult, SandboxLimits } from "./driver";
import { SandboxRuntimeError } from "./driver";
import type { SandboxRegistry } from "./registry";

export class SandboxNotFoundError extends Error {
  constructor() { super("sandbox_not_found"); this.name = "SandboxNotFoundError"; }
}

export class SandboxBusyError extends Error {
  constructor() { super("sandbox_busy"); this.name = "SandboxBusyError"; }
}

export type PublicSandboxState = Readonly<{
  sandboxId: string;
  state: SandboxState;
  leaseExpiresAt: string | null;
  devServer: SandboxDevServerState;
}>;

export class SandboxService {
  private readonly limits: SandboxLimits;

  constructor(
    private readonly registry: SandboxRegistry,
    private readonly driver: SandboxDriver,
    private readonly environment: SandboxEnvironment,
    private readonly clock: () => number = Date.now,
  ) {
    this.limits = {
      cpu: environment.SANDBOX_CPU_LIMIT,
      memoryMb: environment.SANDBOX_MEMORY_MB,
      diskMb: environment.SANDBOX_DISK_MB,
      pids: environment.SANDBOX_PIDS_LIMIT,
      commandTimeoutMs: environment.SANDBOX_COMMAND_TIMEOUT_MS,
    };
  }

  async create(projectId: string): Promise<PublicSandboxState> {
    let record = await this.registry.createOrGet(projectId);
    if (record.status === "stopping") throw new SandboxBusyError();
    if (record.status === "failed" || (record.leaseExpiresAt && record.leaseExpiresAt.getTime() <= this.clock())) {
      await this.reapExpired();
      record = await this.registry.createOrGet(projectId);
      if (record.status === "stopping") throw new SandboxBusyError();
    }
    try {
      await this.driver.create({
        sandboxId: record.id,
        projectId: record.projectId,
        uid: record.runtimeUid,
        image: this.environment.SANDBOX_IMAGE,
        limits: this.limits,
        egressAllowlist: this.environment.SANDBOX_EGRESS_ALLOWLIST,
      });
      const expiresAt = new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000);
      await this.registry.update(record, {
        status: "ready",
        runtimeId: sandboxContainerNameForRecord(record),
        leaseExpiresAt: expiresAt,
        devServerStatus: "stopped",
        devServerPort: null,
        devServerLeaseExpiresAt: null,
      });
      return {
        sandboxId: record.id,
        state: "ready",
        leaseExpiresAt: expiresAt.toISOString(),
        devServer: { status: "stopped", port: null, leaseExpiresAt: null },
      };
    } catch {
      await this.driver.destroy(record.id, record.projectId, record.runtimeUid).catch(() => undefined);
      await this.registry.update(record, {
        status: "failed", leaseExpiresAt: null, devServerStatus: "failed", devServerPort: null, devServerLeaseExpiresAt: null,
      }).catch(() => undefined);
      throw new SandboxRuntimeError("sandbox_create_failed");
    }
  }

  async inspect(projectId: string): Promise<PublicSandboxState> {
    const record = await this.requiredRecord(projectId);
    if (record.status === "stopping") throw new SandboxBusyError();
    if (record.status === "failed" || (record.leaseExpiresAt && record.leaseExpiresAt.getTime() <= this.clock())) {
      await this.reapExpired();
      const fresh = await this.requiredRecord(projectId);
      return this.publicState(fresh);
    }
    if (record.status === "stopped" && record.runtimeId === null) return this.publicState(record);
    const inspection = await this.driver.inspect(record.id, record.projectId, record.runtimeUid);
    if (inspection.state === "missing") {
      await this.registry.update(record, {
        status: "failed", runtimeId: null, leaseExpiresAt: null, devServerStatus: "failed", devServerPort: null, devServerLeaseExpiresAt: null,
      });
      return this.publicState({
        ...record, status: "failed", runtimeId: null, leaseExpiresAt: null,
        devServerStatus: "failed", devServerPort: null, devServerLeaseExpiresAt: null,
      });
    }
    const status: SandboxState = inspection.state === "running" ? "ready" : "stopped";
    const leaseExpiresAt = status === "ready"
      ? record.leaseExpiresAt && record.leaseExpiresAt.getTime() > this.clock()
        ? record.leaseExpiresAt
        : new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000)
      : record.leaseExpiresAt;
    if (status !== record.status || leaseExpiresAt !== record.leaseExpiresAt) {
      await this.registry.update(record, { status, leaseExpiresAt });
    }
    const refreshed = { ...record, status, leaseExpiresAt };
    return this.publicState(refreshed);
  }

  async stop(projectId: string): Promise<PublicSandboxState> {
    const record = await this.requiredRecord(projectId);
    if (record.status === "stopping") throw new SandboxBusyError();
    const expiresAt = new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000);
    await this.registry.update(record, {
      status: "stopping", leaseExpiresAt: expiresAt,
      devServerStatus: "stopped", devServerPort: null, devServerLeaseExpiresAt: null,
    });
    try {
      await this.driver.stop(record.id, record.projectId, record.runtimeUid);
      await this.registry.update(record, {
        status: "stopped", leaseExpiresAt: expiresAt,
        devServerStatus: "stopped", devServerPort: null, devServerLeaseExpiresAt: null,
      });
      return this.publicState({ ...record, status: "stopped", leaseExpiresAt: expiresAt, devServerStatus: "stopped", devServerPort: null, devServerLeaseExpiresAt: null });
    } catch {
      await this.driver.destroy(record.id, record.projectId, record.runtimeUid).catch(() => undefined);
      await this.registry.update(record, {
        status: "failed", leaseExpiresAt: null,
        devServerStatus: "failed", devServerPort: null, devServerLeaseExpiresAt: null,
      }).catch(() => undefined);
      throw new SandboxRuntimeError("sandbox_stop_failed");
    }
  }

  async destroy(projectId: string): Promise<PublicSandboxState> {
    const record = await this.requiredRecord(projectId);
    if (record.status !== "stopping") {
      await this.registry.update(record, {
        status: "stopping", devServerStatus: "stopped", devServerPort: null, devServerLeaseExpiresAt: null,
      });
    }
    try {
      await this.driver.destroy(record.id, record.projectId, record.runtimeUid);
      await this.registry.update(record, {
        status: "stopped", runtimeId: null, leaseExpiresAt: null,
        devServerStatus: "stopped", devServerPort: null, devServerLeaseExpiresAt: null,
      });
      return this.publicState({ ...record, status: "stopped", runtimeId: null, leaseExpiresAt: null, devServerStatus: "stopped", devServerPort: null, devServerLeaseExpiresAt: null });
    } catch {
      await this.registry.update(record, {
        status: "failed", leaseExpiresAt: null,
        devServerStatus: "failed", devServerPort: null, devServerLeaseExpiresAt: null,
      });
      throw new SandboxRuntimeError("sandbox_destroy_failed");
    }
  }

  async exec(projectId: string, argv: readonly string[], cwd = "", timeoutMs = this.environment.SANDBOX_COMMAND_TIMEOUT_MS): Promise<SandboxToolCommandResult> {
    if (argv[0] !== "npm") throw new SandboxRuntimeError("sandbox_command_not_allowed");
    return this.runCommand(projectId, { command: "npm", args: argv.slice(1), cwd, timeoutMs });
  }

  async runCommand(projectId: string, input: SandboxRunCommandInput): Promise<SandboxToolCommandResult> {
    const parsed = SandboxRunCommandInputSchema.safeParse(input);
    if (!parsed.success) throw new SandboxRuntimeError("invalid_tool_input");
    let args: string[];
    try { args = validateSandboxNpmArgs(parsed.data.args); }
    catch { throw new SandboxRuntimeError("sandbox_command_not_allowed"); }
    return toToolResult(await this.executeSandboxCommand(
      projectId, ["npm", ...args], parsed.data.cwd, parsed.data.timeoutMs, SANDBOX_COMMAND_OUTPUT_MAX_BYTES,
    ));
  }

  async installDependencies(projectId: string, input: SandboxInstallDependenciesInput): Promise<SandboxToolCommandResult> {
    const parsed = SandboxInstallDependenciesInputSchema.safeParse(input);
    if (!parsed.success) throw new SandboxRuntimeError("invalid_dependency_specification");
    const args = [
      "install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund",
      "--registry=http://npm-proxy:8080/registry/registry.npmjs.org/", "--",
      ...parsed.data.packages.map(({ name, version }) => `${name}@${version}`),
    ];
    return toToolResult(await this.executeSandboxCommand(
      projectId, ["npm", ...args], "", this.environment.SANDBOX_COMMAND_TIMEOUT_MS, SANDBOX_COMMAND_OUTPUT_MAX_BYTES,
    ));
  }

  async readFile(projectId: string, path: string): Promise<{ path: string; content: string }> {
    const parsed = SandboxReadFileInputSchema.safeParse({ path });
    if (!parsed.success) throw new SandboxRuntimeError("invalid_path");
    const result = await this.executeSandboxCommand(
      projectId, ["/usr/local/bin/workspace-fs", "read", parsed.data.path], "",
      this.environment.SANDBOX_COMMAND_TIMEOUT_MS, SANDBOX_FILE_OUTPUT_MAX_BYTES,
    );
    if (result.exitCode !== 0) throw helperError(result.stderr);
    const encoded = result.stdout.trim();
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new SandboxRuntimeError("file_read_failed");
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
      return { path: parsed.data.path, content };
    } catch { throw new SandboxRuntimeError("file_not_utf8"); }
  }

  async writeFile(projectId: string, path: string, content: string): Promise<{ path: string; bytesWritten: number }> {
    const parsed = SandboxWriteFileInputSchema.safeParse({ path, content });
    if (!parsed.success) throw new SandboxRuntimeError("invalid_tool_input");
    const result = await this.executeSandboxCommand(
      projectId, ["/usr/local/bin/workspace-fs", "write", parsed.data.path], "",
      this.environment.SANDBOX_COMMAND_TIMEOUT_MS, 1024, parsed.data.content,
    );
    if (result.exitCode !== 0) throw helperError(result.stderr);
    const bytesWritten = Number(result.stdout.trim());
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 0 || bytesWritten > 1_048_576) throw new SandboxRuntimeError("file_write_failed");
    return { path: parsed.data.path, bytesWritten };
  }

  async listFiles(projectId: string, path = ""): Promise<{ path: string; files: SandboxFileEntry[] }> {
    const parsed = SandboxListFilesInputSchema.safeParse({ path });
    if (!parsed.success) throw new SandboxRuntimeError("invalid_path");
    const result = await this.executeSandboxCommand(
      projectId, ["/usr/local/bin/workspace-fs", "list", parsed.data.path], "",
      this.environment.SANDBOX_COMMAND_TIMEOUT_MS, SANDBOX_COMMAND_OUTPUT_MAX_BYTES,
    );
    if (result.exitCode !== 0) throw helperError(result.stderr);
    try {
      const files = JSON.parse(result.stdout) as SandboxFileEntry[];
      if (!Array.isArray(files) || files.length > SANDBOX_LIST_MAX_ENTRIES || files.some((file) =>
        typeof file.name !== "string" || !["file", "directory"].includes(file.type) || !Number.isSafeInteger(file.size) || file.size < 0)) {
        throw new Error("invalid_list_response");
      }
      return { path: parsed.data.path, files };
    } catch { throw new SandboxRuntimeError("directory_read_failed"); }
  }

  async startDevServer(projectId: string): Promise<SandboxDevServerState> {
    let record = await this.requiredRecord(projectId);
    if (record.status !== "ready" || !record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= this.clock()) throw new SandboxBusyError();
    if (record.devServerStatus === "ready" && record.devServerPort === SANDBOX_DEV_SERVER_PORT &&
      record.devServerLeaseExpiresAt && record.devServerLeaseExpiresAt.getTime() > this.clock()) {
      const health = await this.executeSandboxCommand(
        projectId, ["node", "/opt/meta-game/server-manager.mjs", "health"], "",
        Math.min(3_000, this.environment.SANDBOX_COMMAND_TIMEOUT_MS), 1024,
      ).catch(() => undefined);
      if (health?.exitCode === 0) return this.serverState(await this.requiredRecord(projectId));
      await this.markDevServerFailed(record);
      record = await this.requiredRecord(projectId);
    }

    const startingLease = new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000);
    if (!await this.registry.claimDevServerStart(record, {
      port: SANDBOX_DEV_SERVER_PORT,
      serverLeaseExpiresAt: startingLease,
      sandboxLeaseExpiresAt: startingLease,
    })) throw new SandboxBusyError();
    const launch = await this.executeSandboxCommand(
      projectId, ["node", "/opt/meta-game/server-manager.mjs", "start"], "",
      this.environment.SANDBOX_COMMAND_TIMEOUT_MS, 1024,
    );
    if (launch.exitCode !== 0) {
      await this.markDevServerFailed(record);
      throw new SandboxRuntimeError("dev_server_start_failed");
    }

    let healthy = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const check = await this.executeSandboxCommand(
        projectId, ["node", "/opt/meta-game/server-manager.mjs", "health"], "",
        Math.min(3_000, this.environment.SANDBOX_COMMAND_TIMEOUT_MS), 1024,
      ).catch(() => undefined);
      if (check?.exitCode === 0) { healthy = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!healthy) {
      await this.executeSandboxCommand(
        projectId, ["node", "/opt/meta-game/server-manager.mjs", "stop"], "",
        Math.min(3_000, this.environment.SANDBOX_COMMAND_TIMEOUT_MS), 1024,
      ).catch(() => undefined);
      await this.markDevServerFailed(record);
      throw new SandboxRuntimeError("dev_server_health_check_failed");
    }

    const current = await this.requiredRecord(projectId);
    const freshExpiry = new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000);
    if (!await this.registry.touch(current, freshExpiry)) throw new SandboxBusyError();
    await this.registry.update(current, {
      status: "ready", devServerStatus: "ready", devServerPort: SANDBOX_DEV_SERVER_PORT,
      devServerLeaseExpiresAt: freshExpiry,
    });
    return { status: "ready", port: SANDBOX_DEV_SERVER_PORT, leaseExpiresAt: freshExpiry.toISOString() };
  }

  async readLogs(projectId: string): Promise<SandboxDevServerLogs> {
    const result = await this.executeSandboxCommand(
      projectId, ["node", "/opt/meta-game/server-manager.mjs", "logs"], "",
      this.environment.SANDBOX_COMMAND_TIMEOUT_MS, SANDBOX_COMMAND_OUTPUT_MAX_BYTES,
    );
    if (result.exitCode !== 0) throw new SandboxRuntimeError("dev_server_logs_failed");
    try {
      const logs = JSON.parse(result.stdout) as { status: string; stdout: string; stderr: string };
      const record = await this.requiredRecord(projectId);
      const status = logs.status === "running" && record.devServerStatus === "ready"
        ? "ready"
        : record.devServerStatus === "starting" ? "starting" : record.devServerStatus === "failed" ? "failed" : "stopped";
      return {
        status,
        port: status === "ready" ? record.devServerPort : null,
        leaseExpiresAt: status === "ready" ? record.devServerLeaseExpiresAt?.toISOString() ?? null : null,
        stdout: typeof logs.stdout === "string" ? logs.stdout.slice(-6_000) : "",
        stderr: typeof logs.stderr === "string" ? logs.stderr.slice(-6_000) : "",
      };
    } catch { throw new SandboxRuntimeError("dev_server_logs_failed"); }
  }

  private async executeSandboxCommand(
    projectId: string,
    argv: readonly string[],
    cwd: string,
    timeoutMs: number | undefined,
    maxOutputBytes: number,
    stdin?: string,
  ): Promise<SandboxExecResult> {
    const record = await this.requiredRecord(projectId);
    if (record.status !== "ready" || !record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= this.clock()) throw new SandboxBusyError();
    const requestedTimeout = timeoutMs ?? this.environment.SANDBOX_COMMAND_TIMEOUT_MS;
    if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1_000 || requestedTimeout > 120_000) throw new SandboxRuntimeError("invalid_timeout");
    const timeout = Math.min(requestedTimeout, this.environment.SANDBOX_COMMAND_TIMEOUT_MS);
    if (!await this.registry.touch(record, new Date(this.clock() + timeout + 30_000))) throw new SandboxBusyError();
    const options: SandboxExecOptions = { maxOutputBytes, ...(stdin !== undefined ? { stdin } : {}) };
    try {
      const result = await this.driver.exec(record.id, record.projectId, record.runtimeUid, argv, cwd, timeout, options);
      const expiresAt = new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000);
      if (!await this.registry.touch(record, expiresAt)) throw new SandboxBusyError();
      return result;
    } catch (error) {
      if (error instanceof SandboxRuntimeError && ["execution_timeout", "runtime_output_limit"].includes(error.code)) {
        await this.registry.update(record, {
          status: "failed", leaseExpiresAt: null, devServerStatus: "failed", devServerPort: null, devServerLeaseExpiresAt: null,
        });
      }
      throw error;
    }
  }

  private async markDevServerFailed(record: SandboxRecord): Promise<void> {
    const current = await this.requiredRecord(record.projectId);
    await this.registry.update(current, {
      status: current.status, devServerStatus: "failed", devServerPort: null, devServerLeaseExpiresAt: null,
    });
  }

  async reapExpired(): Promise<number> {
    const records = await this.registry.claimExpired(50);
    await Promise.all(records.map(async (record) => {
      try {
        await this.driver.destroy(record.id, record.projectId, record.runtimeUid);
        await this.registry.update(record, {
          status: "stopped", runtimeId: null, leaseExpiresAt: null,
          devServerStatus: "stopped", devServerPort: null, devServerLeaseExpiresAt: null,
        });
      } catch {
        await this.registry.update(record, {
          status: "failed", leaseExpiresAt: null,
          devServerStatus: "failed", devServerPort: null, devServerLeaseExpiresAt: null,
        });
      }
    }));
    return records.length;
  }

  private serverState(record: SandboxRecord): SandboxDevServerState {
    const ready = record.devServerStatus === "ready" && record.devServerPort !== null &&
      record.devServerLeaseExpiresAt !== null && record.devServerLeaseExpiresAt.getTime() > this.clock();
    return {
      status: ready ? "ready" : record.devServerStatus === "ready" ? "stopped" : record.devServerStatus,
      port: ready ? record.devServerPort : null,
      leaseExpiresAt: ready ? record.devServerLeaseExpiresAt?.toISOString() ?? null : null,
    };
  }

  private publicState(record: SandboxRecord): PublicSandboxState {
    return {
      sandboxId: record.id,
      state: record.status,
      leaseExpiresAt: record.leaseExpiresAt?.toISOString() ?? null,
      devServer: this.serverState(record),
    };
  }

  private async requiredRecord(projectId: string): Promise<SandboxRecord> {
    const record = await this.registry.get(projectId);
    if (!record) throw new SandboxNotFoundError();
    return record;
  }
}

function helperError(stderr: string): SandboxRuntimeError {
  const code = stderr.trim().split(/\s+/, 1)[0] ?? "sandbox_tool_failed";
  return new SandboxRuntimeError(/^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "sandbox_tool_failed");
}

function toToolResult(result: SandboxExecResult): SandboxToolCommandResult {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    truncated: result.truncated ?? false,
  };
}

function sandboxContainerNameForRecord(record: SandboxRecord): string {
  return `mg-sandbox-${record.id}`;
}

export type SandboxDriverContract = Pick<SandboxDriver, "create" | "inspect" | "stop" | "destroy" | "exec">;
