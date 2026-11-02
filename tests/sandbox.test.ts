import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSandboxEnvironment } from "@meta-game/config";
import type { SandboxRecord, SandboxState } from "@meta-game/db";
import {
  assertSandboxUid,
  buildRootlessContainerConfig,
  createSandboxControllerServer,
  SandboxControllerClient,
  SandboxRuntimeError,
  SandboxBusyError,
  SandboxService,
  resolveWorkspaceCwd,
  validateSandboxArgv,
  type SandboxCreateSpec,
  type SandboxDriver,
  type SandboxExecResult,
  type SandboxInspection,
  type SandboxRegistry,
} from "@meta-game/sandbox";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SANDBOX_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const IMAGE = `registry.example.test/sandbox@sha256:${"a".repeat(64)}`;
const TOKEN = "integration-test-token-1234567890abcdef";

function environment() {
  return parseSandboxEnvironment({
    SANDBOX_DRIVER: "rootless",
    SANDBOX_IMAGE: IMAGE,
    SANDBOX_CONTROLLER_TOKEN: TOKEN,
    SANDBOX_CONTROLLER_HOST: "127.0.0.1",
    SANDBOX_CONTROLLER_PORT: "8081",
    SANDBOX_DOCKER_SOCKET: "/run/user/1001/docker.sock",
    SANDBOX_CPU_LIMIT: "1",
    SANDBOX_MEMORY_MB: "1024",
    SANDBOX_DISK_MB: "2048",
    SANDBOX_PIDS_LIMIT: "128",
    SANDBOX_COMMAND_TIMEOUT_MS: "60000",
    SANDBOX_IDLE_TTL_SECONDS: "900",
  });
}

function fixture() {
  let now = 1_800_000_000_000;
  let record: SandboxRecord | undefined;
  const driverState = new Map<string, "running" | "stopped" | "missing">();
  const driver: SandboxDriver = {
    verifyHost: vi.fn(async () => undefined),
    create: vi.fn(async (spec: SandboxCreateSpec): Promise<SandboxInspection> => {
      driverState.set(spec.sandboxId, "running");
      return { sandboxId: spec.sandboxId, state: "running", uid: spec.uid, limits: spec.limits };
    }),
    inspect: vi.fn(async (sandboxId: string, _projectId: string, uid: number): Promise<SandboxInspection> => ({
      sandboxId,
      state: driverState.get(sandboxId) ?? "missing",
      uid,
      limits: { cpu: 1, memoryMb: 1024, diskMb: 2048, pids: 128, commandTimeoutMs: 60_000 },
    })),
    stop: vi.fn(async (sandboxId: string) => { driverState.set(sandboxId, "stopped"); }),
    destroy: vi.fn(async (sandboxId: string) => { driverState.set(sandboxId, "missing"); }),
    exec: vi.fn(async (): Promise<SandboxExecResult> => ({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 3 })),
  };
  const registry: SandboxRegistry = {
    createOrGet: vi.fn(async (projectId: string) => {
      if (projectId !== PROJECT_ID && projectId !== PROJECT_B_ID) {
        throw Object.assign(new Error("project_not_found"), { name: "SandboxProjectNotFoundError" });
      }
      if (record && record.projectId !== projectId) {
        throw Object.assign(new Error("project_not_found"), { name: "SandboxProjectNotFoundError" });
      }
      if (!record) {
        record = {
          id: SANDBOX_ID,
          ownerUserId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          projectId,
          runtimeUid: projectId === PROJECT_ID ? 23451 : 23452,
          runtimeId: null,
          status: "provisioning",
          leaseExpiresAt: null,
          updatedAt: new Date(now),
        };
      }
      return record;
    }),
    get: vi.fn(async (projectId: string) => record?.projectId === projectId ? record : undefined),
    update: vi.fn(async (_record: SandboxRecord, patch: { status: SandboxState; runtimeId?: string | null; leaseExpiresAt?: Date | null }) => {
      if (record) record = { ...record, ...patch };
    }),
    touch: vi.fn(async (_record: SandboxRecord, leaseExpiresAt: Date) => {
      if (!record || record.status !== "ready" || !record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= now) return false;
      record = { ...record, leaseExpiresAt };
      return true;
    }),
    claimExpired: vi.fn(async () => {
      if (!record) return [];
      const leaseExpired = !record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= now;
      if (!leaseExpired || !["ready", "stopped", "failed"].includes(record.status)) return [];
      const claimed = { ...record, status: "stopping" as const };
      record = claimed;
      return [claimed];
    }),
  };
  const service = new SandboxService(registry, driver, environment(), () => now);
  return {
    driver,
    registry,
    service,
    advance(milliseconds: number) { now += milliseconds; },
    status() { return record?.status; },
  };
}

const servers: Array<ReturnType<typeof createSandboxControllerServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("sandbox rootless contract", () => {
  it("limita UID, argv y rutas al workspace", () => {
    expect(assertSandboxUid(10_000)).toBe(10_000);
    expect(() => assertSandboxUid(60_000)).toThrow(SandboxRuntimeError);
    expect(resolveWorkspaceCwd("src/game")).toBe("/workspace/src/game");
    expect(() => resolveWorkspaceCwd("../etc")).toThrow(SandboxRuntimeError);
    expect(() => validateSandboxArgv(["/bin/sh", "-c", "id"])).toThrow("shell_command_not_allowed");
    expect(validateSandboxArgv(["node", "game.js"])).toEqual(["node", "game.js"]);
  });

  it("genera configuración efectiva sin red, mounts del host ni privilegios", () => {
    const limits = { cpu: 1, memoryMb: 1024, diskMb: 2048, pids: 128, commandTimeoutMs: 60_000 };
    const config = buildRootlessContainerConfig({
      sandboxId: SANDBOX_ID,
      projectId: PROJECT_ID,
      uid: 23451,
      image: IMAGE,
      limits,
    });
    const host = config.body.HostConfig as Record<string, unknown>;
    expect(config.body.User).toBe("23451:23451");
    expect(config.volumeName).toBe(`mg-workspace-${SANDBOX_ID}`);
    expect(config.labels).toMatchObject({
      "com.meta-game.sandbox-id": SANDBOX_ID,
      "com.meta-game.workspace-limit-mb": "2048",
    });
    expect(host).toMatchObject({
      Privileged: false,
      ReadonlyRootfs: true,
      NetworkMode: "none",
      PidMode: "private",
      IpcMode: "private",
      CgroupnsMode: "private",
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Devices: [],
      PortBindings: {},
    });
    expect(host.Mounts).toEqual([{
      Type: "volume",
      Source: `mg-workspace-${SANDBOX_ID}`,
      Target: "/workspace",
      ReadOnly: false,
    }]);
    expect(host.Binds).toBeUndefined();
    expect(() => buildRootlessContainerConfig({
      sandboxId: SANDBOX_ID,
      projectId: PROJECT_ID,
      uid: 23451,
      image: "node:24",
      limits,
    })).toThrow("sandbox_image_must_be_digest_pinned");
  });

  it("rechaza wildcard hosts, digest mutable y token placeholder", () => {
    expect(() => parseSandboxEnvironment({
      SANDBOX_DRIVER: "rootless",
      SANDBOX_IMAGE: "node:24",
      SANDBOX_CONTROLLER_TOKEN: TOKEN,
      SANDBOX_CONTROLLER_HOST: "0.0.0.0",
    })).toThrow("Invalid sandbox environment fields");
    expect(() => parseSandboxEnvironment({
      SANDBOX_DRIVER: "rootless",
      SANDBOX_IMAGE: IMAGE,
      SANDBOX_CONTROLLER_TOKEN: "placeholder-secret-token-value-123456",
    })).toThrow("Invalid sandbox environment fields");
  });

  it("autentica worker, resuelve projectId sin aceptar owner y confina las operaciones", async () => {
    const f = fixture();
    const server = createSandboxControllerServer(f.service, TOKEN);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/`;
    const endpoint = `${url}v1/projects/${PROJECT_ID}/sandbox`;

    const denied = await fetch(endpoint, { method: "POST" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("private, no-store");
    expect(f.driver.create).not.toHaveBeenCalled();

    const client = new SandboxControllerClient(url, TOKEN);
    const created = await client.create(PROJECT_ID);
    expect(created.state).toBe("ready");
    expect(f.driver.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID, uid: 23451 }));

    await expect(client.exec(PROJECT_ID, ["node", "-e", "process.stdout.write('ok')"])).resolves.toMatchObject({ stdout: "ok", exitCode: 0 });
    await expect(client.inspect(PROJECT_ID)).resolves.toMatchObject({ sandboxId: SANDBOX_ID, state: "ready" });
    await expect(client.stop(PROJECT_ID)).resolves.toMatchObject({ state: "stopped" });
    await expect(client.destroy(PROJECT_ID)).resolves.toMatchObject({ state: "stopped" });

    const crossProject = await fetch(`${url}v1/projects/${PROJECT_B_ID}/sandbox`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(crossProject.status).toBe(404);
  });

  it("reclama y destruye sandboxes vencidos usando el TTL guardado", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    f.advance(901_000);
    expect(await f.service.reapExpired()).toBe(1);
    expect(f.driver.destroy).toHaveBeenCalledWith(SANDBOX_ID, PROJECT_ID, 23451);
    expect(f.status()).toBe("stopped");
  });

  it("mantiene TTL al detener y destruye luego el volumen inactivo", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    const stopped = await f.service.stop(PROJECT_ID);
    expect(stopped.state).toBe("stopped");
    expect(stopped.leaseExpiresAt).not.toBeNull();
    f.advance(901_000);
    expect(await f.service.reapExpired()).toBe(1);
    expect(f.driver.destroy).toHaveBeenCalledWith(SANDBOX_ID, PROJECT_ID, 23451);
  });

  it("no ejecuta si la renovación atómica del lease perdió frente al reaper", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    vi.mocked(f.registry.touch).mockResolvedValueOnce(false);
    await expect(f.service.exec(PROJECT_ID, ["node", "game.js"])).rejects.toThrow(SandboxBusyError);
    expect(f.driver.exec).not.toHaveBeenCalled();
  });

  it("no permite ejecutar después de que venció el TTL aunque aún no corra el reaper", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    f.advance(901_000);
    await expect(f.service.exec(PROJECT_ID, ["node", "game.js"])).rejects.toThrow(SandboxBusyError);
    expect(f.driver.exec).not.toHaveBeenCalled();
  });

  it("solo permite HTTP de loopback para el cliente worker", () => {
    expect(() => new SandboxControllerClient("http://sandbox.internal:8081", TOKEN)).toThrow();
    expect(() => new SandboxControllerClient("http://127.0.0.1:8081", "placeholder-token-that-is-way-too-long")).toThrow();
  });
});
