import type { SandboxRecord, SandboxState } from "@meta-game/db";
import type { SandboxEnvironment } from "@meta-game/config";
import type { SandboxDriver, SandboxExecResult, SandboxLimits } from "./driver";
import { SandboxRuntimeError } from "./driver";
import type { SandboxRegistry } from "./registry";

export class SandboxNotFoundError extends Error {
  constructor() { super("sandbox_not_found"); this.name = "SandboxNotFoundError"; }
}

export class SandboxBusyError extends Error {
  constructor() { super("sandbox_busy"); this.name = "SandboxBusyError"; }
}

export type PublicSandboxState = Readonly<{ sandboxId: string; state: SandboxState; leaseExpiresAt: string | null }>;

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
      });
      const expiresAt = new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000);
      await this.registry.update(record, { status: "ready", runtimeId: sandboxContainerNameForRecord(record), leaseExpiresAt: expiresAt });
      return { sandboxId: record.id, state: "ready", leaseExpiresAt: expiresAt.toISOString() };
    } catch {
      await this.driver.destroy(record.id, record.projectId, record.runtimeUid).catch(() => undefined);
      await this.registry.update(record, { status: "failed", leaseExpiresAt: null }).catch(() => undefined);
      throw new SandboxRuntimeError("sandbox_create_failed");
    }
  }

  async inspect(projectId: string): Promise<PublicSandboxState> {
    const record = await this.requiredRecord(projectId);
    if (record.status === "stopping") throw new SandboxBusyError();
    if (record.status === "failed" || (record.leaseExpiresAt && record.leaseExpiresAt.getTime() <= this.clock())) {
      await this.reapExpired();
      const fresh = await this.requiredRecord(projectId);
      return { sandboxId: fresh.id, state: fresh.status, leaseExpiresAt: fresh.leaseExpiresAt?.toISOString() ?? null };
    }
    if (record.status === "stopped" && record.runtimeId === null) {
      return { sandboxId: record.id, state: "stopped", leaseExpiresAt: record.leaseExpiresAt?.toISOString() ?? null };
    }
    const inspection = await this.driver.inspect(record.id, record.projectId, record.runtimeUid);
    if (inspection.state === "missing") {
      await this.registry.update(record, { status: "failed", runtimeId: null, leaseExpiresAt: null });
      return { sandboxId: record.id, state: "failed", leaseExpiresAt: null };
    }
    const status = inspection.state === "running" ? "ready" : "stopped";
    const leaseExpiresAt = status === "ready"
      ? record.leaseExpiresAt && record.leaseExpiresAt.getTime() > this.clock()
        ? record.leaseExpiresAt
        : new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000)
      : status === "stopped" ? record.leaseExpiresAt : null;
    if (status !== record.status || leaseExpiresAt !== record.leaseExpiresAt) {
      await this.registry.update(record, { status, leaseExpiresAt });
    }
    return { sandboxId: record.id, state: status, leaseExpiresAt: leaseExpiresAt?.toISOString() ?? null };
  }

  async stop(projectId: string): Promise<PublicSandboxState> {
    const record = await this.requiredRecord(projectId);
    if (record.status === "stopping") throw new SandboxBusyError();
    const expiresAt = new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000);
    await this.registry.update(record, { status: "stopping", leaseExpiresAt: expiresAt });
    try {
      await this.driver.stop(record.id, record.projectId, record.runtimeUid);
      await this.registry.update(record, { status: "stopped", leaseExpiresAt: expiresAt });
      return { sandboxId: record.id, state: "stopped", leaseExpiresAt: expiresAt.toISOString() };
    } catch {
      await this.driver.destroy(record.id, record.projectId, record.runtimeUid).catch(() => undefined);
      await this.registry.update(record, { status: "failed", leaseExpiresAt: null }).catch(() => undefined);
      throw new SandboxRuntimeError("sandbox_stop_failed");
    }
  }

  async destroy(projectId: string): Promise<PublicSandboxState> {
    const record = await this.requiredRecord(projectId);
    if (record.status !== "stopping") await this.registry.update(record, { status: "stopping" });
    try {
      await this.driver.destroy(record.id, record.projectId, record.runtimeUid);
      await this.registry.update(record, { status: "stopped", runtimeId: null, leaseExpiresAt: null });
      return { sandboxId: record.id, state: "stopped", leaseExpiresAt: null };
    } catch {
      await this.registry.update(record, { status: "failed", leaseExpiresAt: null });
      throw new SandboxRuntimeError("sandbox_destroy_failed");
    }
  }

  async exec(projectId: string, argv: readonly string[], cwd = "", timeoutMs = this.environment.SANDBOX_COMMAND_TIMEOUT_MS): Promise<SandboxExecResult> {
    const record = await this.requiredRecord(projectId);
    if (record.status !== "ready") throw new SandboxBusyError();
    if (!record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= this.clock()) throw new SandboxBusyError();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new SandboxRuntimeError("invalid_timeout");
    }
    const timeout = Math.min(timeoutMs, this.environment.SANDBOX_COMMAND_TIMEOUT_MS);
    const inFlightExpiry = new Date(this.clock() + timeout + 30_000);
    if (!await this.registry.touch(record, inFlightExpiry)) throw new SandboxBusyError();
    try {
      const result = await this.driver.exec(record.id, record.projectId, record.runtimeUid, argv, cwd, timeout);
      const expiresAt = new Date(this.clock() + this.environment.SANDBOX_IDLE_TTL_SECONDS * 1000);
      await this.registry.touch(record, expiresAt);
      return result;
    } catch (error) {
      if (error instanceof SandboxRuntimeError && ["execution_timeout", "runtime_output_limit"].includes(error.code)) {
        await this.registry.update(record, { status: "failed", leaseExpiresAt: null });
      }
      throw error;
    }
  }

  async reapExpired(): Promise<number> {
    const records = await this.registry.claimExpired(50);
    await Promise.all(records.map(async (record) => {
      try {
        await this.driver.destroy(record.id, record.projectId, record.runtimeUid);
        await this.registry.update(record, { status: "stopped", runtimeId: null, leaseExpiresAt: null });
      } catch {
        await this.registry.update(record, { status: "failed", leaseExpiresAt: null });
      }
    }));
    return records.length;
  }

  private async requiredRecord(projectId: string): Promise<SandboxRecord> {
    const record = await this.registry.get(projectId);
    if (!record) throw new SandboxNotFoundError();
    return record;
  }

}

function sandboxContainerNameForRecord(record: SandboxRecord): string {
  return `mg-sandbox-${record.id}`;
}

export type SandboxDriverContract = Pick<SandboxDriver, "create" | "inspect" | "stop" | "destroy" | "exec">;
