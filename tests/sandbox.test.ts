import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSandboxEnvironment, TelemetryMetrics, withTelemetryContext } from "@meta-game/config";
import type { SandboxRecord, SandboxState } from "@meta-game/db";
import {
  assertSandboxUid,
  buildRootlessContainerConfig,
  buildSandboxNetworkConfig,
  createSandboxControllerServer,
  SandboxControllerClient,
  SandboxRuntimeError,
  SandboxBusyError,
  SandboxService,
  resolveWorkspaceCwd,
  validateSandboxArgv,
  type SandboxCreateSpec,
  type SandboxDriver,
  type SandboxExecOptions,
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
    exec: vi.fn(async (
      _sandboxId: string,
      _projectId: string,
      _uid: number,
      argv: readonly string[],
      _cwd: string,
      _timeoutMs: number,
      options: SandboxExecOptions = {},
    ): Promise<SandboxExecResult> => {
      if (argv[0] === "/usr/local/bin/workspace-fs" && argv[1] === "write") {
        const stdin = options.stdin ?? "";
        const bytesWritten = typeof stdin === "string" ? Buffer.byteLength(stdin, "utf8") : stdin.byteLength;
        return { stdout: `${bytesWritten}\n`, stderr: "", exitCode: 0, durationMs: 2 };
      }
      if (argv[0] === "/usr/local/bin/workspace-fs" && argv[1] === "read") {
        return { stdout: `${Buffer.from("export {};", "utf8").toString("base64")}\n`, stderr: "", exitCode: 0, durationMs: 2 };
      }
      if (argv[0] === "/usr/local/bin/workspace-fs" && argv[1] === "list") {
        return { stdout: "[]", stderr: "", exitCode: 0, durationMs: 2 };
      }
      if (argv[0] === "node" && argv[2] === "logs") {
        return { stdout: JSON.stringify({ status: "running", stdout: "vite ready", stderr: "" }), stderr: "", exitCode: 0, durationMs: 2 };
      }
      if (argv[0] === "node" && argv[2] === "health") {
        return { stdout: "healthy", stderr: "", exitCode: 0, durationMs: 2 };
      }
      if (argv[0] === "node" && argv[1] === "/opt/meta-game/verify-game.mjs") {
        return { stdout: JSON.stringify({ status: "passed", checks: [], consoleErrors: [], blockedRequests: 0 }), stderr: "", exitCode: 0, durationMs: 3 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 3 };
    }),
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
          devServerStatus: "stopped",
          devServerPort: null,
          devServerLeaseExpiresAt: null,
          lifecycleLeaseToken: null,
          lifecycleLeaseExpiresAt: null,
          lifecycleSnapshotId: null,
          lifecycleSnapshotSha256: null,
          lifecycleSnapshotSizeBytes: null,
          updatedAt: new Date(now),
        };
      }
      return record;
    }),
    get: vi.fn(async (projectId: string) => record?.projectId === projectId ? record : undefined),
    getForCleanup: vi.fn(async (projectId: string) => record?.projectId === projectId ? record : undefined),
    update: vi.fn(async (_record: SandboxRecord, patch: {
      status: SandboxState;
      runtimeId?: string | null;
      leaseExpiresAt?: Date | null;
      devServerStatus?: SandboxRecord["devServerStatus"];
      devServerPort?: number | null;
      devServerLeaseExpiresAt?: Date | null;
      lifecycleLeaseToken?: string | null;
      lifecycleLeaseExpiresAt?: Date | null;
      lifecycleSnapshotId?: string | null;
      lifecycleSnapshotSha256?: string | null;
      lifecycleSnapshotSizeBytes?: number | null;
    }) => {
      if (record) record = { ...record, ...patch };
    }),
    touch: vi.fn(async (_record: SandboxRecord, leaseExpiresAt: Date) => {
      if (!record || record.status !== "ready" || !record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= now) return false;
      record = {
        ...record,
        leaseExpiresAt,
        ...(record.devServerStatus === "ready" ? { devServerLeaseExpiresAt: leaseExpiresAt } : {}),
      };
      return true;
    }),
    claimDevServerStart: vi.fn(async (_record: SandboxRecord, input: {
      port: number;
      serverLeaseExpiresAt: Date;
      sandboxLeaseExpiresAt: Date;
    }) => {
      if (!record || record.status !== "ready" || !record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= now) return false;
      const available = record.devServerStatus === "stopped" || record.devServerStatus === "failed" ||
        ((record.devServerStatus === "ready" || record.devServerStatus === "starting") &&
          (!record.devServerLeaseExpiresAt || record.devServerLeaseExpiresAt.getTime() <= now));
      if (!available) return false;
      record = {
        ...record,
        leaseExpiresAt: input.sandboxLeaseExpiresAt,
        devServerStatus: "starting",
        devServerPort: input.port,
        devServerLeaseExpiresAt: input.serverLeaseExpiresAt,
      };
      return true;
    }),
    claimExpired: vi.fn(async () => {
      if (!record) return [];
      const leaseExpired = !record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= now;
      if (!leaseExpired || !["stopped", "failed"].includes(record.status)) return [];
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
  it("accepts Docker Desktop Compose with an immutable local image ID and bounded tmpfs", () => {
    const desktop = parseSandboxEnvironment({
      SANDBOX_DRIVER: "rootless",
      SANDBOX_IMAGE: `sha256:${"d".repeat(64)}`,
      SANDBOX_CONTROLLER_TOKEN: TOKEN,
      SANDBOX_CONTROLLER_HOST: "0.0.0.0",
      SANDBOX_CONTROLLER_PORT: "8081",
      SANDBOX_DOCKER_SOCKET: "/var/run/docker.sock",
      SANDBOX_HOST_RUNTIME_MODE: "docker-desktop-security",
      SANDBOX_WORKSPACE_MODE: "tmpfs",
      SANDBOX_CPU_LIMIT: "1",
      SANDBOX_MEMORY_MB: "1024",
      SANDBOX_DISK_MB: "2048",
      SANDBOX_PIDS_LIMIT: "128",
      SANDBOX_COMMAND_TIMEOUT_MS: "60000",
      SANDBOX_IDLE_TTL_SECONDS: "900",
    });

    expect(desktop).toMatchObject({
      SANDBOX_IMAGE: `sha256:${"d".repeat(64)}`,
      SANDBOX_CONTROLLER_HOST: "0.0.0.0",
      SANDBOX_HOST_RUNTIME_MODE: "docker-desktop-security",
      SANDBOX_WORKSPACE_MODE: "tmpfs",
    });
  });

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
    expect(buildSandboxNetworkConfig({
      sandboxId: SANDBOX_ID,
      projectId: PROJECT_ID,
      uid: 23451,
      image: IMAGE,
      limits,
    })).toMatchObject({
      Name: `mg-sandbox-net-${SANDBOX_ID}`,
      Driver: "bridge",
      Internal: true,
      EnableIPv6: true,
      Options: {
        "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
        "com.docker.network.bridge.gateway_mode_ipv6": "isolated",
      },
    });
    const host = config.body.HostConfig as Record<string, unknown>;
    expect(config.body.User).toBe("23451:23451");
    expect(config.volumeName).toBe(`mg-workspace-${SANDBOX_ID}`);
    expect(config.labels).toMatchObject({
      "com.meta-game.sandbox-id": SANDBOX_ID,
      "com.meta-game.workspace-limit-mb": "2048",
      "com.meta-game.workspace-mode": "user-quota",
    });
    expect(host).toMatchObject({
      Privileged: false,
      ReadonlyRootfs: true,
      Dns: ["127.0.0.1"],
      NetworkMode: `mg-sandbox-net-${SANDBOX_ID}`,
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
    expect(host.PidMode).toBeUndefined();
    expect(host.IpcMode).toBeUndefined();
    expect(host.ExtraHosts).toEqual(["npm-proxy:172.16.0.2"]);
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
    expect(() => buildRootlessContainerConfig({
      sandboxId: SANDBOX_ID,
      projectId: PROJECT_ID,
      uid: 23451,
      image: IMAGE,
      limits,
    }, "8.8.8.8")).toThrow("egress_proxy_address_invalid");
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

  it("confina archivos, npm y comandos a sus contratos tipados", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    await expect(f.service.writeFile(PROJECT_ID, "src/main.ts", "export {};"))
      .resolves.toEqual({ path: "src/main.ts", bytesWritten: 10 });
    const binaryAsset = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    await expect(f.service.writeBinaryFile(PROJECT_ID, "public/assets/generated/00000000-0000-4000-8000-000000000001.png", binaryAsset))
      .resolves.toEqual({ path: "public/assets/generated/00000000-0000-4000-8000-000000000001.png", bytesWritten: binaryAsset.byteLength });
    await expect(f.service.writeBinaryFile(PROJECT_ID, "public/assets/generated/tilesets/00000000-0000-4000-8000-000000000001.png", binaryAsset))
      .resolves.toEqual({ path: "public/assets/generated/tilesets/00000000-0000-4000-8000-000000000001.png", bytesWritten: binaryAsset.byteLength });
    await expect(f.service.writeBinaryFile(PROJECT_ID, "src/other.png", binaryAsset)).rejects.toThrow("invalid_tool_input");
    await expect(f.service.readFile(PROJECT_ID, "src/main.ts"))
      .resolves.toEqual({ path: "src/main.ts", content: "export {};" });
    await expect(f.service.listFiles(PROJECT_ID)).resolves.toEqual({ path: "", files: [] });
    await expect(f.service.installDependencies(PROJECT_ID, { packages: [{ name: "phaser", version: "3.90.0" }] }))
      .resolves.toMatchObject({ exitCode: 0, truncated: false });
    await expect(f.service.runCommand(PROJECT_ID, { command: "npm", args: ["run", "build"] }))
      .resolves.toMatchObject({ stdout: "ok", exitCode: 0 });
    await expect(f.service.installDependencies(PROJECT_ID, { packages: [{ name: "https://evil.example/x.tgz", version: "latest" }] }))
      .rejects.toThrow("invalid_dependency_specification");
    await expect(f.service.installDependencies(PROJECT_ID, { packages: [{ name: "is-number", version: "7.0.0" }] }))
      .rejects.toThrow("dependency_not_approved");
    await expect(f.service.runCommand(PROJECT_ID, { command: "npm", args: ["exec", "--", "node", "-e", "bad"] }))
      .rejects.toThrow("sandbox_command_not_allowed");
    await expect(f.service.exec(PROJECT_ID, ["sh", "-c", "id"]))
      .rejects.toThrow("sandbox_command_not_allowed");
    expect(f.driver.exec).toHaveBeenCalledWith(
      SANDBOX_ID,
      PROJECT_ID,
      23451,
      ["/usr/local/bin/workspace-fs", "write", "src/main.ts"],
      "",
      60_000,
      expect.objectContaining({ stdin: "export {};" }),
    );
    expect(f.driver.exec).toHaveBeenCalledWith(
      SANDBOX_ID,
      PROJECT_ID,
      23451,
      ["/usr/local/bin/workspace-fs", "write", "public/assets/generated/00000000-0000-4000-8000-000000000001.png"],
      "",
      60_000,
      expect.objectContaining({ stdin: binaryAsset }),
    );
  });

  it("ejecuta la verificación de interacción con el runner confiable dentro del sandbox y exige preview saludable", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    const input = { genre: "puzzle" as const, controls: { movement: "arrows" as const, action: "space" as const, touch: true as const } };
    await expect(f.service.verifyGameInteraction(PROJECT_ID, input)).rejects.toThrow("game_browser_preview_unhealthy");
    await f.service.startDevServer(PROJECT_ID);
    await expect(f.service.verifyGameInteraction(PROJECT_ID, input)).resolves.toMatchObject({ status: "passed", checks: [] });
    expect(f.driver.exec).toHaveBeenCalledWith(
      SANDBOX_ID, PROJECT_ID, 23451, ["node", "/opt/meta-game/verify-game.mjs"], "", 30_000,
      expect.objectContaining({ stdin: JSON.stringify(input) }),
    );
  });

  it("registra el servidor dev con health check y logs acotados", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    const starts = await Promise.allSettled([
      f.service.startDevServer(PROJECT_ID),
      f.service.startDevServer(PROJECT_ID),
    ]);
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(starts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(vi.mocked(f.driver.exec).mock.calls.filter((call) => call[3][2] === "start")).toHaveLength(1);
    await expect(f.service.inspect(PROJECT_ID)).resolves.toMatchObject({
      state: "ready",
      devServer: { status: "ready", port: 4173 },
    });
    await expect(f.service.readLogs(PROJECT_ID)).resolves.toMatchObject({
      status: "ready", port: 4173, stdout: "vite ready", stderr: "",
    });
    f.advance(60_000);
    await expect(f.service.startDevServer(PROJECT_ID)).resolves.toMatchObject({
      status: "ready", port: 4173, leaseExpiresAt: new Date(1_800_000_000_000 + 960_000).toISOString(),
    });
    expect(vi.mocked(f.driver.exec).mock.calls.filter((call) => call[3][2] === "start")).toHaveLength(1);
  });

  it("recupera un dev server vivo cuando el health check falla una vez", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    await f.service.startDevServer(PROJECT_ID);
    // El servidor sigue vivo, pero el siguiente health check falla: el
    // reintento debe detener el supervisor anterior antes de arrancar otro,
    // en vez de chocar con dev_server_already_running y marcar failed.
    let failNextHealth = true;
    let alive = true;
    const original = vi.mocked(f.driver.exec).getMockImplementation()!;
    vi.mocked(f.driver.exec).mockImplementation(async (...args) => {
      const argv = args[3];
      if (argv[0] === "node" && argv[2] === "health" && failNextHealth) {
        failNextHealth = false;
        return { stdout: "", stderr: "dev_server_unhealthy", exitCode: 2, durationMs: 1 };
      }
      if (argv[0] === "node" && argv[2] === "stop") alive = false;
      if (argv[0] === "node" && argv[2] === "start") {
        if (alive) return { stdout: "", stderr: "dev_server_already_running", exitCode: 2, durationMs: 1 };
        alive = true;
      }
      return original(...args);
    });
    await expect(f.service.startDevServer(PROJECT_ID)).resolves.toMatchObject({ status: "ready", port: 4173 });
    await expect(f.service.inspect(PROJECT_ID)).resolves.toMatchObject({ devServer: { status: "ready", port: 4173 } });
  });

  it("autentica worker, resuelve projectId sin aceptar owner y confina las operaciones", async () => {
    const f = fixture();
    const metrics = new TelemetryMetrics("sandbox-controller");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const server = createSandboxControllerServer(f.service, TOKEN, metrics);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/`;
    const endpoint = `${url}v1/projects/${PROJECT_ID}/sandbox`;
    const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const denied = await fetch(endpoint, { method: "POST" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("private, no-store");
    expect(f.driver.create).not.toHaveBeenCalled();

    const client = new SandboxControllerClient(url, TOKEN);
    const created = await withTelemetryContext({ runId }, () => client.create(PROJECT_ID));
    expect(created.state).toBe("ready");
    expect(f.driver.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID, uid: 23451 }));
    const createLog = output.mock.calls.map(([chunk]) => String(chunk)).find((line) => line.includes('"event":"sandbox.operation_completed"') && line.includes('"operation":"create"'));
    expect(createLog).toContain('"runId":"' + runId + '"');
    expect(createLog).not.toContain(TOKEN);
    expect(createLog).not.toContain(PROJECT_ID);
    expect(metrics.value("sandbox_operations_total", { operation: "create", outcome: "success" })).toBe(1);
    output.mockRestore();

    await expect(client.exec(PROJECT_ID, ["npm", "run", "build"])).resolves.toMatchObject({ stdout: "ok", exitCode: 0, truncated: false });
    await expect(client.writeBinaryFile(PROJECT_ID, "public/assets/generated/00000000-0000-4000-8000-000000000002.png", new Uint8Array([137, 80, 78, 71])))
      .resolves.toMatchObject({ path: "public/assets/generated/00000000-0000-4000-8000-000000000002.png", bytesWritten: 4 });
    await expect(client.writeBinaryFile(PROJECT_ID, "public/assets/generated/tilesets/00000000-0000-4000-8000-000000000002.png", new Uint8Array([137, 80, 78, 71])))
      .resolves.toMatchObject({ path: "public/assets/generated/tilesets/00000000-0000-4000-8000-000000000002.png", bytesWritten: 4 });
    await client.startDevServer(PROJECT_ID);
    await expect(client.verifyGameInteraction(PROJECT_ID, {
      genre: "puzzle",
      controls: { movement: "arrows", action: "space", touch: true },
    })).resolves.toMatchObject({ status: "passed", checks: [] });
    await expect(client.inspect(PROJECT_ID)).resolves.toMatchObject({ sandboxId: SANDBOX_ID, state: "ready" });
    await expect(client.stop(PROJECT_ID)).resolves.toMatchObject({ state: "stopped" });
    await expect(client.destroy(PROJECT_ID)).resolves.toMatchObject({ state: "stopped" });

    const crossProject = await fetch(`${url}v1/projects/${PROJECT_B_ID}/sandbox`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(crossProject.status).toBe(404);
  });

  it("deja los sandboxes listos vencidos para el sweeper con snapshot recuperable", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    f.advance(901_000);
    expect(await f.service.reapExpired()).toBe(0);
    expect(f.driver.destroy).not.toHaveBeenCalled();
    expect(f.status()).toBe("ready");
  });

  it("detiene un sandbox de proyecto borrado sin destruir antes la retención", async () => {
    const test = fixture();
    await test.service.create(PROJECT_ID);
    await test.service.quiesceManagedProject(PROJECT_ID);
    expect(test.driver.stop).toHaveBeenCalledTimes(1);
    expect(test.driver.destroy).not.toHaveBeenCalled();
    expect(test.status()).toBe("stopped");
  });

  it("mantiene la suspensión bajo lease hasta que el worker confirme el CAS", async () => {
    const test = fixture();
    await test.service.create(PROJECT_ID);
    const record = await test.registry.get(PROJECT_ID);
    expect(record).toBeDefined();
    await test.registry.update(record!, {
      status: "suspending",
      lifecycleLeaseToken: "lease-token-for-test",
      lifecycleLeaseExpiresAt: new Date(1_800_000_060_000),
      lifecycleSnapshotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      lifecycleSnapshotSha256: "a".repeat(64),
      lifecycleSnapshotSizeBytes: 128,
    });

    await expect(test.service.destroy(PROJECT_ID)).resolves.toMatchObject({ state: "suspending" });
    expect(test.status()).toBe("suspending");
    expect(test.driver.destroy).toHaveBeenCalledTimes(1);
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
    await expect(f.service.exec(PROJECT_ID, ["npm", "run", "build"])).rejects.toThrow(SandboxBusyError);
    expect(f.driver.exec).not.toHaveBeenCalled();
  });

  it("no permite ejecutar después de que venció el TTL aunque aún no corra el reaper", async () => {
    const f = fixture();
    await f.service.create(PROJECT_ID);
    f.advance(901_000);
    await expect(f.service.exec(PROJECT_ID, ["npm", "run", "build"])).rejects.toThrow(SandboxBusyError);
    expect(f.driver.exec).not.toHaveBeenCalled();
  });

  it("allows HTTP only on loopback or the exact private Compose endpoint", () => {
    expect(() => new SandboxControllerClient("http://sandbox.internal:8081", TOKEN)).toThrow();
    expect(() => new SandboxControllerClient("http://sandbox-controller:8081", TOKEN)).not.toThrow();
    expect(() => new SandboxControllerClient("http://sandbox-controller:8082", TOKEN)).toThrow();
    expect(() => new SandboxControllerClient("http://127.0.0.1:8081", "placeholder-token-that-is-way-too-long")).toThrow();
  });
});
