import { request as httpRequest, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  SandboxCreateSpec,
  SandboxDriver,
  SandboxExecResult,
  SandboxInspection,
  SandboxLimits,
  SandboxRuntimeState,
} from "./driver";
import {
  SandboxRuntimeError,
  assertSandboxUid,
  resolveWorkspaceCwd,
  sandboxContainerName,
  sandboxVolumeName,
  validateSandboxArgv,
} from "./driver";

type DockerInfo = { SecurityOptions?: string[]; CgroupVersion?: string; CgroupDriver?: string; Driver?: string };
type DockerVolume = { Driver: string; Labels?: Record<string, string>; Options?: Record<string, string> | null };

const hostCheckUid = 60_000;
const hostCheckDiskMb = 16;

function assertHostCheckUid(uid: number): number {
  if (uid !== hostCheckUid) throw new SandboxRuntimeError("invalid_sandbox_uid");
  return uid;
}
type DockerInspect = {
  Id: string;
  State: { Status: string; Running: boolean };
  Config: { Labels?: Record<string, string>; User?: string; Image?: string; WorkingDir?: string };
  HostConfig: {
    Privileged: boolean;
    ReadonlyRootfs: boolean;
    NetworkMode: string;
    PidMode?: string;
    IpcMode?: string;
    CgroupnsMode?: string;
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    PidsLimit: number;
    CapDrop?: string[];
    SecurityOpt?: string[];
    Binds?: string[] | null;
    PortBindings?: Record<string, unknown> | null;
    Devices?: unknown[];
    CapAdd?: string[] | null;
    Tmpfs?: Record<string, string>;
    RestartPolicy?: { Name?: string };
  };
  Mounts: Array<{ Type: string; Name?: string; Source?: string; Destination: string; RW: boolean }>;
};

class DockerEngineClient {
  constructor(private readonly socketPath: string) {
    if (!socketPath.startsWith("/")) throw new SandboxRuntimeError("invalid_runtime_socket");
  }

  async request<T>(method: string, path: string, body?: unknown, accepted: readonly number[] = [200, 201, 204]): Promise<T> {
    const response = await this.raw(method, path, body, 1_000_000);
    if (!accepted.includes(response.status)) {
      if (response.status === 404) throw new SandboxRuntimeError("runtime_not_found");
      if (response.status === 409) throw new SandboxRuntimeError("runtime_conflict");
      throw new SandboxRuntimeError("runtime_operation_failed");
    }
    if (!response.body.length) return undefined as T;
    try { return JSON.parse(response.body.toString("utf8")) as T; }
    catch { throw new SandboxRuntimeError("runtime_invalid_response"); }
  }

  async raw(method: string, path: string, body?: unknown, maxBytes = 128_000, signal?: AbortSignal): Promise<{ status: number; body: Buffer }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = httpRequest({
        socketPath: this.socketPath,
        path: `/v1.47${path}`,
        method,
        signal,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : undefined,
      }, (res) => {
        void collectResponse(res, maxBytes).then((bytes) => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, body: bytes });
        }, (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });
      req.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(signal?.aborted ? new SandboxRuntimeError("execution_timeout") : new SandboxRuntimeError("runtime_unavailable", error.message));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}

async function collectResponse(stream: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new SandboxRuntimeError("runtime_output_limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function assertContainerSecurity(inspect: DockerInspect, spec: SandboxCreateSpec, hostCheck = false): number {
  const uid = hostCheck ? assertHostCheckUid(spec.uid) : assertSandboxUid(spec.uid);
  const expectedCpu = Math.round(spec.limits.cpu * 1_000_000_000);
  const workspace = inspect.Mounts.filter((mount) => mount.Destination === "/workspace");
  const safe = inspect.Config.Labels?.["com.meta-game.sandbox-id"] === spec.sandboxId &&
    inspect.Config.Labels?.["com.meta-game.managed"] === "true" &&
    inspect.Config.Labels?.["com.meta-game.project-id"] === spec.projectId &&
    inspect.Config.Labels?.["com.meta-game.workspace-limit-mb"] === String(spec.limits.diskMb) &&
    inspect.Config.Image === spec.image &&
    inspect.Config.User === `${uid}:${uid}` &&
    inspect.Config.WorkingDir === "/workspace" &&
    inspect.HostConfig.Privileged === false &&
    inspect.HostConfig.ReadonlyRootfs === true &&
    inspect.HostConfig.NetworkMode === "none" &&
    inspect.HostConfig.PidMode === "private" &&
    inspect.HostConfig.IpcMode === "private" &&
    inspect.HostConfig.CgroupnsMode === "private" &&
    inspect.HostConfig.Memory === spec.limits.memoryMb * 1024 * 1024 &&
    inspect.HostConfig.MemorySwap === spec.limits.memoryMb * 1024 * 1024 &&
    inspect.HostConfig.NanoCpus === expectedCpu &&
    inspect.HostConfig.PidsLimit === spec.limits.pids &&
    inspect.HostConfig.CapDrop?.includes("ALL") === true &&
    (inspect.HostConfig.CapAdd?.length ?? 0) === 0 &&
    inspect.HostConfig.SecurityOpt?.includes("no-new-privileges:true") === true &&
    !inspect.HostConfig.SecurityOpt?.some((option) => option.toLowerCase().includes("seccomp=unconfined")) &&
    inspect.HostConfig.Tmpfs?.["/tmp"] === "rw,noexec,nosuid,nodev,size=64m,mode=1777" &&
    inspect.HostConfig.Tmpfs?.["/run"] === "rw,noexec,nosuid,nodev,size=8m,mode=1777" &&
    inspect.HostConfig.RestartPolicy?.Name === "no" &&
    (inspect.HostConfig.Binds?.length ?? 0) === 0 &&
    Object.keys(inspect.HostConfig.PortBindings ?? {}).length === 0 &&
    (inspect.HostConfig.Devices?.length ?? 0) === 0 &&
    inspect.Mounts.every((mount) => ["/workspace", "/tmp", "/run"].includes(mount.Destination)) &&
    workspace.length === 1 && workspace[0]?.Type === "volume" &&
    workspace[0]?.Name === sandboxVolumeName(spec.sandboxId) && workspace[0]?.RW === true;
  if (!safe) throw new SandboxRuntimeError("sandbox_security_invariant_failed");
  return uid;
}

function buildContainerConfig(spec: SandboxCreateSpec, hostCheck: boolean): {
  containerName: string;
  volumeName: string;
  labels: Record<string, string>;
  body: Record<string, unknown>;
} {
  const uid = hostCheck ? assertHostCheckUid(spec.uid) : assertSandboxUid(spec.uid);
  const containerName = sandboxContainerName(spec.sandboxId);
  const volumeName = sandboxVolumeName(spec.sandboxId);
  if (!spec.image.includes("@sha256:")) throw new SandboxRuntimeError("sandbox_image_must_be_digest_pinned");
  const labels = {
    "com.meta-game.managed": "true",
    "com.meta-game.sandbox-id": spec.sandboxId,
    "com.meta-game.project-id": spec.projectId,
    "com.meta-game.workspace-limit-mb": String(spec.limits.diskMb),
  };
  return {
    containerName,
    volumeName,
    labels,
    body: {
      Image: spec.image,
      User: `${uid}:${uid}`,
      WorkingDir: "/workspace",
      Cmd: ["/bin/sleep", "infinity"],
      Labels: labels,
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        NetworkMode: "none",
        PidMode: "private",
        IpcMode: "private",
        CgroupnsMode: "private",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: spec.limits.memoryMb * 1024 * 1024,
        MemorySwap: spec.limits.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(spec.limits.cpu * 1_000_000_000),
        PidsLimit: spec.limits.pids,
        Tmpfs: {
          "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
          "/run": "rw,noexec,nosuid,nodev,size=8m,mode=1777",
        },
        Mounts: [{
          Type: "volume",
          Source: volumeName,
          Target: "/workspace",
          ReadOnly: false,
        }],
        Devices: [],
        PortBindings: {},
        RestartPolicy: { Name: "no" },
      },
    },
  };
}

export function buildRootlessContainerConfig(spec: SandboxCreateSpec): ReturnType<typeof buildContainerConfig> {
  return buildContainerConfig(spec, false);
}

function dockerState(state: DockerInspect["State"]): SandboxRuntimeState {
  if (state.Running) return "running";
  if (["created", "restarting"].includes(state.Status)) return "created";
  return "stopped";
}

const cgroupProbeProgram = [
  "const fs=require('node:fs');const cp=require('node:child_process');",
  "const stat=fs.statfsSync('/workspace');const read=n=>fs.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim();",
  "const uid=process.getuid();const map=fs.readFileSync('/proc/self/uid_map','utf8').trim().split('\\n').map(x=>x.trim().split(/\\s+/).map(Number));",
  "const row=map.find(([inside,,length])=>uid>=inside&&uid<inside+length);const hostUid=row&&row[1]+uid-row[0];",
  "const maxRow=map.find(([inside,,length])=>59999>=inside&&59999<inside+length);const maxHostUid=maxRow&&maxRow[1]+59999-maxRow[0];",
  "const memory=Number(read('memory.max'));const pids=Number(read('pids.max'));const cpu=read('cpu.max').split(/\\s+/).map(Number);",
  "const probeRow=map.find(([inside,,length])=>60000>=inside&&60000<inside+length);const probeHostUid=probeRow&&probeRow[1]+60000-probeRow[0];",
  "if(uid!==60000||!hostUid||hostUid===0||!maxHostUid||maxHostUid===0||!probeHostUid||probeHostUid===0||probeHostUid===maxHostUid||memory!==134217728||pids!==16||!Number.isFinite(cpu[0])||!Number.isFinite(cpu[1])||cpu[1]<=0||cpu[0]/cpu[1]>0.25||![0xef53,0x58465342].includes(stat.type))process.exit(30);",
  "try{fs.writeFileSync('/etc/rootless-probe','x');process.exit(31)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')process.exit(32)}",
  "let full=false,written=0;for(let i=0;i<32&&!full;i++){try{fs.writeFileSync('/workspace/probe-'+i,Buffer.alloc(1024*1024));written+=1024*1024}catch(e){if(e.code==='ENOSPC')full=true;else process.exit(33)}}",
  "if(!full||written<15*1024*1024||written>17*1024*1024)process.exit(34);for(const name of fs.readdirSync('/workspace'))fs.unlinkSync('/workspace/'+name);",
  "const kids=[];let denied=false;for(let i=0;i<64;i++){const child=cp.spawn('/bin/sleep',['10']);child.on('error',e=>{if(e.code==='EAGAIN')denied=true});kids.push(child)}",
  "setTimeout(()=>{for(const child of kids)child.kill('SIGKILL');setTimeout(()=>process.exit(denied?0:35),100)},500)",
].join("");

const memoryProbeProgram = "const chunks=[];for(let i=0;i<256;i++)chunks.push(Buffer.alloc(1024*1024,1));";

export class RootlessDockerDriver implements SandboxDriver {
  private readonly client: DockerEngineClient;

  constructor(
    socketPath: string,
    private readonly image: string,
    private readonly defaultLimits: SandboxLimits,
  ) {
    this.client = new DockerEngineClient(socketPath);
  }

  async verifyHost(): Promise<void> {
    const info = await this.client.request<DockerInfo>("GET", "/info");
    const securityOptions = (info.SecurityOptions ?? []).map((option) => option.toLowerCase());
    if (!securityOptions.some((option) => option.includes("rootless"))) throw new SandboxRuntimeError("rootless_runtime_required");
    if (info.CgroupVersion !== "2") throw new SandboxRuntimeError("cgroups_v2_required");
    if (info.CgroupDriver !== "systemd") throw new SandboxRuntimeError("systemd_cgroup_driver_required");
    if (!securityOptions.some((option) => option.includes("seccomp"))) throw new SandboxRuntimeError("seccomp_required");
    if (!info.Driver || !["overlay2", "overlayfs", "fuse-overlayfs"].includes(info.Driver)) {
      throw new SandboxRuntimeError("unsupported_runtime_storage_driver");
    }
    const spec: SandboxCreateSpec = {
      sandboxId: randomUUID(),
      projectId: randomUUID(),
      uid: hostCheckUid,
      image: this.image,
      limits: { cpu: 0.25, memoryMb: 128, diskMb: hostCheckDiskMb, pids: 16, commandTimeoutMs: 10_000 },
    };
    try {
      await this.createWithSpec(spec, true);
      const limitsProbe = await this.execWithSpec(spec, ["node", "-e", cgroupProbeProgram], "", 10_000, true);
      if (limitsProbe.exitCode !== 0) throw new SandboxRuntimeError("sandbox_limits_probe_failed");
      const memoryProbe = await this.execWithSpec(spec, ["node", "-e", memoryProbeProgram], "", 15_000, true);
      if (memoryProbe.exitCode !== 137) throw new SandboxRuntimeError("sandbox_memory_probe_failed");
    } catch (error) {
      throw error instanceof SandboxRuntimeError ? error : new SandboxRuntimeError("sandbox_host_probe_failed");
    } finally {
      await this.destroyWithSpec(spec, true).catch(() => {
        throw new SandboxRuntimeError("sandbox_host_probe_cleanup_failed");
      });
    }
  }

  async create(spec: SandboxCreateSpec): Promise<SandboxInspection> {
    return this.createWithSpec(spec, false);
  }

  private async createWithSpec(spec: SandboxCreateSpec, hostCheck: boolean): Promise<SandboxInspection> {
    if (spec.image !== this.image) throw new SandboxRuntimeError("sandbox_image_mismatch");
    const config = buildContainerConfig(spec, hostCheck);
    await this.ensureWorkspaceVolume(config.volumeName, config.labels, spec.limits.diskMb);
    let runtime: { Id: string };
    try {
      runtime = await this.client.request<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(config.containerName)}`, config.body, [201]);
    } catch (error) {
      if (!(error instanceof SandboxRuntimeError) || error.code !== "runtime_conflict") throw error;
      const existing = await this.inspectByName(config.containerName);
      if (!existing) throw error;
      assertContainerSecurity(existing, spec, hostCheck);
      runtime = { Id: existing.Id };
    }

    try {
      await this.client.request("POST", `/containers/${encodeURIComponent(runtime.Id)}/start`, undefined, [204, 304]);
      return await this.inspectAndVerify(spec, runtime.Id, hostCheck);
    } catch (error) {
      throw error instanceof SandboxRuntimeError ? error : new SandboxRuntimeError("runtime_operation_failed");
    }
  }

  async inspect(sandboxId: string, projectId: string, uid: number): Promise<SandboxInspection> {
    const runtime = await this.inspectByName(sandboxContainerName(sandboxId));
    if (!runtime) return { sandboxId, state: "missing", uid: assertSandboxUid(uid), limits: this.defaultLimits };
    await this.verifyWorkspaceVolume(sandboxId, projectId, this.defaultLimits.diskMb);
    const spec = { sandboxId, projectId, uid, image: this.image, limits: this.defaultLimits };
    assertContainerSecurity(runtime, spec);
    return {
      sandboxId,
      state: dockerState(runtime.State),
      uid,
      limits: this.defaultLimits,
    };
  }

  async stop(sandboxId: string, projectId: string, uid: number): Promise<void> {
    await this.stopWithSpec({ sandboxId, projectId, uid, image: this.image, limits: this.defaultLimits });
  }

  private async stopWithSpec(spec: SandboxCreateSpec, hostCheck = false): Promise<void> {
    const runtime = await this.inspectByName(sandboxContainerName(spec.sandboxId));
    if (!runtime) return;
    await this.verifyWorkspaceVolume(spec.sandboxId, spec.projectId, spec.limits.diskMb);
    assertContainerSecurity(runtime, spec, hostCheck);
    await this.client.request("POST", `/containers/${encodeURIComponent(runtime.Id)}/stop?t=5`, undefined, [204, 304]);
  }

  async destroy(sandboxId: string, projectId: string, uid: number): Promise<void> {
    await this.destroyWithSpec({ sandboxId, projectId, uid, image: this.image, limits: this.defaultLimits });
  }

  private async destroyWithSpec(spec: SandboxCreateSpec, hostCheck = false): Promise<void> {
    const runtime = await this.inspectByName(sandboxContainerName(spec.sandboxId));
    if (runtime) {
      await this.verifyWorkspaceVolume(spec.sandboxId, spec.projectId, spec.limits.diskMb);
      assertContainerSecurity(runtime, spec, hostCheck);
      if (runtime.State.Running) await this.stopWithSpec(spec, hostCheck);
      await this.client.request("DELETE", `/containers/${encodeURIComponent(runtime.Id)}?force=true&v=1`, undefined, [204, 404]);
    }
    const volumeName = sandboxVolumeName(spec.sandboxId);
    try {
      const volume = await this.client.request<DockerVolume>("GET", `/volumes/${encodeURIComponent(volumeName)}`);
      if (volume.Labels?.["com.meta-game.sandbox-id"] !== spec.sandboxId ||
        volume.Labels?.["com.meta-game.managed"] !== "true" ||
        volume.Labels?.["com.meta-game.project-id"] !== spec.projectId ||
        volume.Labels?.["com.meta-game.workspace-limit-mb"] !== String(spec.limits.diskMb)) {
        throw new SandboxRuntimeError("sandbox_volume_identity_mismatch");
      }
      await this.client.request("DELETE", `/volumes/${encodeURIComponent(volumeName)}?force=false`, undefined, [204, 404]);
    } catch (error) {
      if (!(error instanceof SandboxRuntimeError) || error.code !== "runtime_not_found") throw error;
    }
  }

  async exec(sandboxId: string, projectId: string, uid: number, argv: readonly string[], cwd: string, timeoutMs: number): Promise<SandboxExecResult> {
    return this.execWithSpec({ sandboxId, projectId, uid, image: this.image, limits: this.defaultLimits }, argv, cwd, timeoutMs);
  }

  private async execWithSpec(spec: SandboxCreateSpec, argv: readonly string[], cwd: string, timeoutMs: number, hostCheck = false): Promise<SandboxExecResult> {
    const safeArgv = validateSandboxArgv(argv);
    const workingDir = resolveWorkspaceCwd(cwd);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > spec.limits.commandTimeoutMs) throw new SandboxRuntimeError("invalid_timeout");
    const runtime = await this.inspectByName(sandboxContainerName(spec.sandboxId));
    if (!runtime || !runtime.State.Running) throw new SandboxRuntimeError("sandbox_not_running");
    await this.verifyWorkspaceVolume(spec.sandboxId, spec.projectId, spec.limits.diskMb);
    assertContainerSecurity(runtime, spec, hostCheck);
    const createdAt = performance.now();
    const exec = await this.client.request<{ Id: string }>("POST", `/containers/${encodeURIComponent(runtime.Id)}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: safeArgv,
      WorkingDir: workingDir,
      User: runtime.Config.User,
      Privileged: false,
    }, [201]);
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
    timer.unref();
    let stream: Buffer;
    try {
      const response = await this.client.raw("POST", `/exec/${encodeURIComponent(exec.Id)}/start`, { Detach: false, Tty: false }, 128_000, abort.signal);
      if (response.status !== 200) throw new SandboxRuntimeError("sandbox_exec_failed");
      stream = response.body;
    } catch (error) {
      if (timedOut) {
        await this.stopWithSpec(spec, hostCheck).catch(() => undefined);
        throw new SandboxRuntimeError("execution_timeout");
      }
      if (error instanceof SandboxRuntimeError && error.code === "runtime_output_limit") {
        await this.stopWithSpec(spec, hostCheck).catch(() => undefined);
      }
      throw error instanceof SandboxRuntimeError ? error : new SandboxRuntimeError("sandbox_exec_failed");
    } finally {
      clearTimeout(timer);
    }
    const { stdout, stderr } = decodeDockerStream(stream);
    const inspection = await this.client.request<{ ExitCode: number }>("GET", `/exec/${encodeURIComponent(exec.Id)}/json`);
    return { stdout, stderr, exitCode: inspection.ExitCode, durationMs: Math.max(0, Math.round(performance.now() - createdAt)) };
  }

  private async ensureWorkspaceVolume(name: string, labels: Record<string, string>, diskMb: number): Promise<void> {
    try {
      await this.client.request("POST", "/volumes/create", {
        Name: name,
        Driver: "local",
        Labels: labels,
      }, [201]);
    } catch (error) {
      if (!(error instanceof SandboxRuntimeError) || error.code !== "runtime_conflict") throw error;
    }
    const sandboxId = labels["com.meta-game.sandbox-id"];
    const projectId = labels["com.meta-game.project-id"];
    if (!sandboxId || !projectId) throw new SandboxRuntimeError("sandbox_volume_identity_mismatch");
    await this.verifyWorkspaceVolume(sandboxId, projectId, diskMb);
  }

  private async verifyWorkspaceVolume(sandboxId: string, projectId: string, diskMb: number): Promise<void> {
    const volume = await this.client.request<DockerVolume>(
      "GET", `/volumes/${encodeURIComponent(sandboxVolumeName(sandboxId))}`,
    );
    if (volume.Driver !== "local" || volume.Labels?.["com.meta-game.sandbox-id"] !== sandboxId ||
      volume.Labels?.["com.meta-game.managed"] !== "true" ||
      volume.Labels?.["com.meta-game.project-id"] !== projectId ||
      volume.Labels?.["com.meta-game.workspace-limit-mb"] !== String(diskMb) ||
      Object.keys(volume.Options ?? {}).length !== 0) {
      throw new SandboxRuntimeError("sandbox_volume_identity_mismatch");
    }
  }

  private async inspectByName(name: string): Promise<DockerInspect | undefined> {
    try {
      return await this.client.request<DockerInspect>("GET", `/containers/${encodeURIComponent(name)}/json`);
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === "runtime_not_found") return undefined;
      throw error;
    }
  }

  private async inspectAndVerify(spec: SandboxCreateSpec, runtimeId: string, hostCheck = false): Promise<SandboxInspection> {
    const inspect = await this.client.request<DockerInspect>("GET", `/containers/${encodeURIComponent(runtimeId)}/json`);
    const uid = assertContainerSecurity(inspect, spec, hostCheck);
    return { sandboxId: spec.sandboxId, state: dockerState(inspect.State), uid, limits: spec.limits };
  }

}

function decodeDockerStream(body: Buffer): { stdout: string; stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  let total = 0;
  while (offset < body.length) {
    if (body.length - offset < 8) throw new SandboxRuntimeError("runtime_invalid_response");
    const streamType = body[offset];
    const length = body.readUInt32BE(offset + 4);
    offset += 8;
    if ((streamType !== 1 && streamType !== 2) || length > body.length - offset) throw new SandboxRuntimeError("runtime_invalid_response");
    total += length;
    if (total > 64_000) throw new SandboxRuntimeError("runtime_output_limit");
    const chunk = body.subarray(offset, offset + length);
    (streamType === 1 ? stdout : stderr).push(chunk);
    offset += length;
  }
  return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}
