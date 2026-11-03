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
  egressProxyContainerName,
  sandboxNetworkName,
  sandboxVolumeName,
  validateSandboxArgv,
} from "./driver";

const sharedEgressNetwork = "mg-sandbox-egress";
const proxyPort = 8080;
const registryUrl = `http://npm-proxy:${proxyPort}/registry/registry.npmjs.org/`;

type DockerInfo = { SecurityOptions?: string[]; CgroupVersion?: string; CgroupDriver?: string; Driver?: string; ServerVersion?: string; OperatingSystem?: string };
type DockerVolume = { Driver: string; Labels?: Record<string, string>; Options?: Record<string, string> | null };
type DockerNetwork = {
  Id: string;
  Name: string;
  Driver: string;
  Internal: boolean;
  EnableIPv6?: boolean;
  Options?: Record<string, string>;
  Labels?: Record<string, string>;
  Containers?: Record<string, { Name?: string }>;
  IPAM?: { Config?: Array<{ Subnet?: string }> };
};

const hostCheckUid = 60_000;
const hostCheckDiskMb = 16;
const hostCheckMemoryMb = 512;
const hostCheckPids = 64;
const hostCheckCpu = 0.5;
type WorkspaceVolumeMode = "user-quota" | "tmpfs";
type HostRuntimeMode = "rootless" | "docker-desktop-security";

function workspaceTmpfsOptions(spec: SandboxCreateSpec): string {
  // Generated projects load lockfile-pinned native Node addons such as Rollup from this mount.
  return `rw,exec,nosuid,nodev,size=${spec.limits.diskMb}m,uid=${spec.uid},gid=${spec.uid},mode=0770`;
}

function assertHostCheckUid(uid: number): number {
  if (uid !== hostCheckUid) throw new SandboxRuntimeError("invalid_sandbox_uid");
  return uid;
}

function isPrivateNetworkIpv4(value: string | undefined): value is string {
  if (!value || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return false;
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function privateProxyIpv4For(network: DockerNetwork): string | undefined {
  const subnet = network.IPAM?.Config?.map((config) => config.Subnet).find((value) => value && /^\d{1,3}(?:\.\d{1,3}){3}\/\d+$/.test(value));
  if (!subnet) return undefined;
  const [address, prefixText] = subnet.split("/");
  const prefix = Number(prefixText);
  const addressParts = address?.split(".").map(Number) ?? [];
  if (addressParts.length !== 4 || addressParts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
    !Number.isInteger(prefix) || prefix < 8 || prefix > 30) return undefined;
  const addressNumber = addressParts.reduce((total, part) => total * 256 + part, 0);
  const blockSize = 2 ** (32 - prefix);
  const networkNumber = Math.floor(addressNumber / blockSize) * blockSize;
  const proxyNumber = networkNumber + 2;
  if (proxyNumber >= networkNumber + blockSize - 1) return undefined;
  const proxyIp = [
    Math.floor(proxyNumber / 2 ** 24) % 256,
    Math.floor(proxyNumber / 2 ** 16) % 256,
    Math.floor(proxyNumber / 2 ** 8) % 256,
    proxyNumber % 256,
  ].join(".");
  return isPrivateNetworkIpv4(proxyIp) ? proxyIp : undefined;
}

type DockerNetworkEndpoint = { IPAddress?: string; IPAMConfig?: { IPv4Address?: string }; Aliases?: string[] };

type DockerInspect = {
  Id: string;
  State: { Status: string; Running: boolean };
  Config: { Labels?: Record<string, string>; User?: string; Image?: string; WorkingDir?: string; Cmd?: string[]; Env?: string[] };
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
    Dns?: string[];
    ExtraHosts?: string[];
  };
  Mounts: Array<{ Type: string; Name?: string; Source?: string; Destination: string; RW: boolean }>;
  NetworkSettings?: { Networks?: Record<string, DockerNetworkEndpoint> };
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

  async raw(method: string, path: string, body?: unknown, maxBytes = 128_000, signal?: AbortSignal, allowTruncate = false): Promise<{ status: number; body: Buffer; truncated: boolean }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = httpRequest({
        socketPath: this.socketPath,
        path: `/v1.48${path}`,
        method,
        signal,
        headers: payload ? { "content-type": "application/json", "content-length": payload.length } : undefined,
      }, (res) => {
        void collectResponse(res, maxBytes, allowTruncate).then(({ bytes, truncated }) => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, body: bytes, truncated });
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

  async hijack(path: string, body: unknown, input: string | Uint8Array, maxBytes: number, signal?: AbortSignal): Promise<{ status: number; body: Buffer; truncated: boolean }> {
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let detachAbort = () => {};
      const finish = (status: number) => {
        if (settled) return;
        settled = true;
        detachAbort();
        resolve({ status, body: Buffer.concat(chunks, size), truncated });
      };
      const req = httpRequest({
        socketPath: this.socketPath,
        path: `/v1.48${path}`,
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          connection: "Upgrade",
          upgrade: "tcp",
        },
      }, (response) => {
        void collectResponse(response, maxBytes, true).then(({ bytes, truncated: responseTruncated }) => {
          if (settled) return;
          settled = true;
          resolve({ status: response.statusCode ?? 0, body: bytes, truncated: responseTruncated });
        }, (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });
      req.once("upgrade", (response, socket, head) => {
        const abort = () => {
          if (settled) return;
          settled = true;
          detachAbort();
          socket.destroy();
          reject(new SandboxRuntimeError("execution_timeout"));
        };
        if (signal?.aborted) { abort(); return; }
        if (signal) {
          signal.addEventListener("abort", abort, { once: true });
          detachAbort = () => signal.removeEventListener("abort", abort);
        }
        const append = (chunk: Buffer) => {
          if (size >= maxBytes) { truncated = true; return; }
          const available = maxBytes - size;
          const kept = chunk.subarray(0, available);
          chunks.push(kept);
          size += kept.length;
          if (kept.length < chunk.length) truncated = true;
        };
        if (head.length) append(head);
        socket.on("data", (value: Buffer) => append(Buffer.isBuffer(value) ? value : Buffer.from(value)));
        socket.once("end", () => finish(response.statusCode ?? 0));
        socket.once("close", () => finish(response.statusCode ?? 0));
        socket.once("error", (error) => {
          if (settled) return;
          settled = true;
          detachAbort();
          reject(error);
        });
        if (input.length) socket.write(typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input));
        socket.end();
      });
      req.once("error", (error) => {
        if (settled) return;
        settled = true;
        detachAbort();
        reject(signal?.aborted ? new SandboxRuntimeError("execution_timeout") : error);
      });
      req.write(payload);
      req.end();
    });
  }
}

async function collectResponse(stream: IncomingMessage, maxBytes: number, truncate: boolean): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const available = maxBytes - size;
    if (chunk.length > available) {
      if (!truncate) {
        stream.destroy();
        throw new SandboxRuntimeError("runtime_output_limit");
      }
      if (available > 0) chunks.push(chunk.subarray(0, available));
      size = maxBytes;
      truncated = true;
    } else if (!truncated) {
      chunks.push(chunk);
      size += chunk.length;
    }
  }
  return { bytes: Buffer.concat(chunks, size), truncated };
}

function assertContainerSecurity(
  inspect: DockerInspect,
  spec: SandboxCreateSpec,
  proxyIp: string,
  hostCheck = false,
  workspaceMode: WorkspaceVolumeMode = "user-quota",
): number {
  const uid = hostCheck ? assertHostCheckUid(spec.uid) : assertSandboxUid(spec.uid);
  const expectedCpu = Math.round(spec.limits.cpu * 1_000_000_000);
  const workspace = inspect.Mounts.filter((mount) => mount.Destination === "/workspace");
  const workspaceMountSafe = workspaceMode === "tmpfs"
    ? workspace.length === 0 && inspect.HostConfig.Tmpfs?.["/workspace"] === workspaceTmpfsOptions(spec)
    : workspace.length === 1 && workspace[0]?.Type === "volume" &&
      workspace[0]?.Name === sandboxVolumeName(spec.sandboxId) && workspace[0]?.RW === true;
  const allowedEnvironment = new Set([
    "PATH", "NODE_VERSION", "YARN_VERSION", "HOME", "TMPDIR", "NODE_ENV", "npm_config_cache",
    "NPM_CONFIG_REGISTRY", "NPM_CONFIG_UPDATE_NOTIFIER", "PLAYWRIGHT_BROWSERS_PATH",
  ]);
  const environmentSafe = (inspect.Config.Env ?? []).every((entry) => {
    const separator = entry.indexOf("=");
    return separator > 0 && allowedEnvironment.has(entry.slice(0, separator));
  });
  const environmentValues = new Map((inspect.Config.Env ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const sandboxSettingsSafe = environmentValues.get("NPM_CONFIG_REGISTRY") === registryUrl &&
    environmentValues.get("NPM_CONFIG_UPDATE_NOTIFIER") === "false" &&
    environmentValues.get("npm_config_cache") === "/tmp/npm-cache" &&
    environmentValues.get("PLAYWRIGHT_BROWSERS_PATH") === "/opt/meta-game/browsers";
  const privateNamespace = (value: string | undefined) => value === undefined || value === "" || value === "private";
  const safe = inspect.Config.Labels?.["com.meta-game.sandbox-id"] === spec.sandboxId &&
    inspect.Config.Labels?.["com.meta-game.managed"] === "true" &&
    inspect.Config.Labels?.["com.meta-game.project-id"] === spec.projectId &&
    inspect.Config.Labels?.["com.meta-game.workspace-limit-mb"] === String(spec.limits.diskMb) &&
    inspect.Config.Labels?.["com.meta-game.workspace-mode"] === workspaceMode &&
    inspect.Config.Image === spec.image &&
    inspect.Config.User === `${uid}:${uid}` &&
    inspect.Config.WorkingDir === "/workspace" &&
    JSON.stringify(inspect.HostConfig.ExtraHosts) === JSON.stringify([`npm-proxy:${proxyIp}`]) &&
    environmentSafe && sandboxSettingsSafe &&
    inspect.HostConfig.Privileged === false &&
    inspect.HostConfig.ReadonlyRootfs === true &&
    inspect.HostConfig.NetworkMode === sandboxNetworkName(spec.sandboxId) &&
    JSON.stringify(inspect.HostConfig.Dns) === JSON.stringify(["127.0.0.1"]) &&
    privateNamespace(inspect.HostConfig.PidMode) &&
    privateNamespace(inspect.HostConfig.IpcMode) &&
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
    (workspaceMode !== "tmpfs" || inspect.HostConfig.Tmpfs?.["/workspace"] === workspaceTmpfsOptions(spec)) &&
    inspect.HostConfig.RestartPolicy?.Name === "no" &&
    (inspect.HostConfig.Binds?.length ?? 0) === 0 &&
    Object.keys(inspect.HostConfig.PortBindings ?? {}).length === 0 &&
    (inspect.HostConfig.Devices?.length ?? 0) === 0 &&
    inspect.Mounts.every((mount) => ["/workspace", "/tmp", "/run"].includes(mount.Destination)) &&
    workspaceMountSafe;
  if (!safe) throw new SandboxRuntimeError("sandbox_security_invariant_failed");
  return uid;
}

function buildContainerConfig(
  spec: SandboxCreateSpec,
  hostCheck: boolean,
  proxyIp: string,
  workspaceMode: WorkspaceVolumeMode = "user-quota",
  allowLocalImageTag = false,
): {
  containerName: string;
  volumeName: string;
  labels: Record<string, string>;
  body: Record<string, unknown>;
} {
  const uid = hostCheck ? assertHostCheckUid(spec.uid) : assertSandboxUid(spec.uid);
  const containerName = sandboxContainerName(spec.sandboxId);
  const volumeName = sandboxVolumeName(spec.sandboxId);
  if (!isPrivateNetworkIpv4(proxyIp)) throw new SandboxRuntimeError("egress_proxy_address_invalid");
  if (!allowLocalImageTag && !spec.image.includes("@sha256:")) throw new SandboxRuntimeError("sandbox_image_must_be_digest_pinned");
  const labels = {
    "com.meta-game.managed": "true",
    "com.meta-game.sandbox-id": spec.sandboxId,
    "com.meta-game.project-id": spec.projectId,
    "com.meta-game.workspace-limit-mb": String(spec.limits.diskMb),
    "com.meta-game.workspace-mode": workspaceMode,
  };
  const tmpfs: Record<string, string> = {
    "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
    "/run": "rw,noexec,nosuid,nodev,size=8m,mode=1777",
  };
  if (workspaceMode === "tmpfs") tmpfs["/workspace"] = workspaceTmpfsOptions(spec);
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
        NetworkMode: sandboxNetworkName(spec.sandboxId),
        Dns: ["127.0.0.1"],
        ExtraHosts: [`npm-proxy:${proxyIp}`],
        CgroupnsMode: "private",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: spec.limits.memoryMb * 1024 * 1024,
        MemorySwap: spec.limits.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(spec.limits.cpu * 1_000_000_000),
        PidsLimit: spec.limits.pids,
        Tmpfs: tmpfs,
        Mounts: workspaceMode === "user-quota" ? [{
          Type: "volume",
          Source: volumeName,
          Target: "/workspace",
          ReadOnly: false,
        }] : [],
        Devices: [],
        PortBindings: {},
        RestartPolicy: { Name: "no" },
      },
      Env: [
        `NPM_CONFIG_REGISTRY=${registryUrl}`,
        "NPM_CONFIG_UPDATE_NOTIFIER=false",
      ],
    },
  };
}

function sandboxNetworkLabels(spec: SandboxCreateSpec): Record<string, string> {
  return {
    "com.meta-game.managed": "true",
    "com.meta-game.network-kind": "sandbox",
    "com.meta-game.sandbox-id": spec.sandboxId,
    "com.meta-game.project-id": spec.projectId,
  };
}

function assertSandboxNetwork(network: DockerNetwork, spec: SandboxCreateSpec): void {
  const labels = network.Labels ?? {};
  if (network.Name !== sandboxNetworkName(spec.sandboxId) || network.Driver !== "bridge" || network.Internal !== true ||
    network.EnableIPv6 !== true ||
    network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated" ||
    network.Options?.["com.docker.network.bridge.gateway_mode_ipv6"] !== "isolated" ||
    labels["com.meta-game.managed"] !== "true" || labels["com.meta-game.network-kind"] !== "sandbox" ||
    labels["com.meta-game.sandbox-id"] !== spec.sandboxId || labels["com.meta-game.project-id"] !== spec.projectId) {
    throw new SandboxRuntimeError("sandbox_network_identity_mismatch");
  }
}

function assertEgressNetwork(network: DockerNetwork): void {
  if (network.Name !== sharedEgressNetwork || network.Driver !== "bridge" || network.Internal !== false ||
    network.Labels?.["com.meta-game.managed"] !== "true" || network.Labels?.["com.meta-game.network-kind"] !== "egress") {
    throw new SandboxRuntimeError("egress_network_identity_mismatch");
  }
}

export function buildRootlessContainerConfig(spec: SandboxCreateSpec, proxyIp = "172.16.0.2"): ReturnType<typeof buildContainerConfig> {
  return buildContainerConfig(spec, false, proxyIp);
}

export function buildSandboxNetworkConfig(spec: SandboxCreateSpec): Record<string, unknown> {
  return {
    Name: sandboxNetworkName(spec.sandboxId),
    Driver: "bridge",
    Internal: true,
    EnableIPv6: true,
    Attachable: false,
    CheckDuplicate: true,
    Options: {
      "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
      "com.docker.network.bridge.gateway_mode_ipv6": "isolated",
    },
    Labels: sandboxNetworkLabels(spec),
  };
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
  "if(uid!==60000||!hostUid||hostUid===0||!maxHostUid||maxHostUid===0||!probeHostUid||probeHostUid===0||probeHostUid===maxHostUid||memory!==536870912||pids!==64||!Number.isFinite(cpu[0])||!Number.isFinite(cpu[1])||cpu[1]<=0||cpu[0]/cpu[1]>0.5||![0xef53,0x58465342].includes(stat.type))process.exit(30);",
  "try{fs.writeFileSync('/etc/rootless-probe','x');process.exit(31)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')process.exit(32)}",
  "let full=false,written=0;for(let i=0;i<32&&!full;i++){try{fs.writeFileSync('/workspace/probe-'+i,Buffer.alloc(1024*1024));written+=1024*1024}catch(e){if(e.code==='ENOSPC')full=true;else process.exit(33)}}",
  "if(!full||written<15*1024*1024||written>17*1024*1024)process.exit(34);for(const name of fs.readdirSync('/workspace'))fs.unlinkSync('/workspace/'+name);",
  "const kids=[];let denied=false;for(let i=0;i<64;i++){const child=cp.spawn('/bin/sleep',['10']);child.on('error',e=>{if(e.code==='EAGAIN')denied=true});kids.push(child)}",
  "setTimeout(()=>{for(const child of kids)child.kill('SIGKILL');setTimeout(()=>process.exit(denied?0:35),100)},500)",
].join("");

const dockerDesktopCgroupProbeProgram = [
  "const fs=require('node:fs');const stat=fs.statfsSync('/workspace');const read=n=>fs.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim();",
  "const status=fs.readFileSync('/proc/self/status','utf8');const caps=/^CapEff:\\s*([0-9a-f]+)$/mi.exec(status)?.[1];const seccomp=Number(/^Seccomp:\\s*(\\d+)$/mi.exec(status)?.[1]);",
  "const memory=Number(read('memory.max'));const pids=Number(read('pids.max'));const cpu=read('cpu.max').split(/\\s+/).map(Number);",
  "if(process.getuid()!==60000||memory!==536870912||pids!==64||!Number.isFinite(cpu[0])||!Number.isFinite(cpu[1])||cpu[1]<=0||cpu[0]/cpu[1]>0.5||caps!=='0000000000000000'||seccomp!==2||stat.type!==0x01021994)process.exit(30);",
  "try{fs.writeFileSync('/etc/security-probe','x');process.exit(31)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')process.exit(32)}",
  "let full=false,written=0;for(let i=0;i<32&&!full;i++){try{fs.writeFileSync('/workspace/probe-'+i,Buffer.alloc(1024*1024));written+=1024*1024}catch(e){if(e.code==='ENOSPC')full=true;else process.exit(33)}}",
  "if(!full||written<15*1024*1024||written>17*1024*1024)process.exit(34);for(const name of fs.readdirSync('/workspace'))fs.unlinkSync('/workspace/'+name);",
].join("");

const networkProbeProgram = [
  "const assert=require('node:assert/strict');(async()=>{",
  "const proxy=await fetch('http://npm-proxy:8080/healthz',{signal:AbortSignal.timeout(2000)});if(proxy.status!==200)throw new Error('proxy_health_status_'+proxy.status);",
  "const metadata=await fetch('http://npm-proxy:8080/registry/registry.npmjs.org/phaser',{signal:AbortSignal.timeout(5000)});if(metadata.status!==200)throw new Error('registry_status_'+metadata.status);",
  "const targets=['http://1.1.1.1/','http://10.0.0.1/','http://100.100.100.200/latest/meta-data','http://169.254.169.254/latest/meta-data','http://169.254.170.2/v2/metadata','http://172.16.0.1/','http://192.168.1.1/','http://[2606:4700:4700::1111]/','http://[fd00::1]/','http://[fe80::1]/'];",
  "const direct=await Promise.all(targets.map(url=>fetch(url,{signal:AbortSignal.timeout(1500)}).then(()=>false,()=>true)));assert.ok(direct.every(Boolean));",
  "const privateHost=await fetch('http://npm-proxy:8080/registry/127.0.0.1/latest',{signal:AbortSignal.timeout(2000)});assert.equal(privateHost.status,403);",
  "const resolver=new (require('node:dns').Resolver)();resolver.setServers(['1.1.1.1']);",
  "const externalDns=await Promise.race([new Promise(resolve=>resolver.resolve4('registry.npmjs.org',error=>resolve(!error))),new Promise(resolve=>setTimeout(()=>resolve(false),1500))]);assert.equal(externalDns,false);",
  "})().catch(error=>{console.error(error.name+':'+error.message);process.exit(41)});",
].join("");

export class RootlessDockerDriver implements SandboxDriver {
  private readonly client: DockerEngineClient;
  private readonly hostRuntimeMode: HostRuntimeMode;
  private readonly workspaceMode: WorkspaceVolumeMode;
  private createdEgressNetwork = false;

  constructor(
    socketPath: string,
    private readonly image: string,
    private readonly defaultLimits: SandboxLimits,
    private readonly egressAllowlist: readonly string[] = ["registry.npmjs.org"],
    options: { hostRuntimeMode?: HostRuntimeMode; workspaceMode?: WorkspaceVolumeMode } = {},
  ) {
    this.client = new DockerEngineClient(socketPath);
    this.hostRuntimeMode = options.hostRuntimeMode ?? "rootless";
    this.workspaceMode = options.workspaceMode ?? "user-quota";
    if ((this.hostRuntimeMode === "rootless") !== (this.workspaceMode === "user-quota")) {
      throw new SandboxRuntimeError("sandbox_runtime_mode_mismatch");
    }
  }

  private async ensureEgressNetwork(): Promise<void> {
    try {
      await this.client.request("POST", "/networks/create", {
        Name: sharedEgressNetwork,
        Driver: "bridge",
        Internal: false,
        Attachable: false,
        CheckDuplicate: true,
        Labels: { "com.meta-game.managed": "true", "com.meta-game.network-kind": "egress" },
      }, [201]);
      this.createdEgressNetwork = true;
    } catch (error) {
      if (!(error instanceof SandboxRuntimeError) || error.code !== "runtime_conflict") throw error;
    }
    const network = await this.client.request<DockerNetwork>("GET", `/networks/${encodeURIComponent(sharedEgressNetwork)}`);
    assertEgressNetwork(network);
  }

  async disposeSecurityRuntime(): Promise<void> {
    if (this.hostRuntimeMode !== "docker-desktop-security") throw new SandboxRuntimeError("security_runtime_cleanup_not_allowed");
    if (!this.createdEgressNetwork) return;
    const network = await this.client.request<DockerNetwork>("GET", `/networks/${encodeURIComponent(sharedEgressNetwork)}`);
    assertEgressNetwork(network);
    if (Object.keys(network.Containers ?? {}).length) throw new SandboxRuntimeError("security_runtime_network_in_use");
    await this.client.request("DELETE", `/networks/${encodeURIComponent(network.Id)}`, undefined, [204, 404]);
    this.createdEgressNetwork = false;
  }

  private async ensureSandboxNetwork(spec: SandboxCreateSpec): Promise<void> {
    const networkName = sandboxNetworkName(spec.sandboxId);
    try {
      await this.client.request("POST", "/networks/create", buildSandboxNetworkConfig(spec), [201]);
    } catch (error) {
      if (!(error instanceof SandboxRuntimeError) || error.code !== "runtime_conflict") throw error;
    }
    const network = await this.client.request<DockerNetwork>("GET", `/networks/${encodeURIComponent(networkName)}`);
    assertSandboxNetwork(network, spec);
  }

  private async ensureEgressProxy(spec: SandboxCreateSpec): Promise<string> {
    const proxyName = egressProxyContainerName(spec.sandboxId);
    let runtime = await this.inspectByName(proxyName);
    if (!runtime) {
      const labels = {
        "com.meta-game.managed": "true",
        "com.meta-game.runtime-kind": "egress-proxy",
        "com.meta-game.sandbox-id": spec.sandboxId,
        "com.meta-game.project-id": spec.projectId,
      };
      try {
        runtime = await this.client.request<DockerInspect>("POST", `/containers/create?name=${encodeURIComponent(proxyName)}`, {
          Image: spec.image,
          User: "10000:10000",
          WorkingDir: "/opt/meta-game",
          Cmd: ["node", "/opt/meta-game/egress-proxy.mjs"],
          Env: [
            `SANDBOX_EGRESS_ALLOWLIST=${(spec.egressAllowlist ?? this.egressAllowlist).join(",")}`,
            `SANDBOX_ID=${spec.sandboxId}`,
          ],
          Labels: labels,
          HostConfig: {
            Privileged: false,
            ReadonlyRootfs: true,
            NetworkMode: sharedEgressNetwork,
            CgroupnsMode: "private",
            Memory: 128 * 1024 * 1024,
            MemorySwap: 128 * 1024 * 1024,
            NanoCpus: 250_000_000,
            PidsLimit: 64,
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges:true"],
            Devices: [],
            PortBindings: {},
            RestartPolicy: { Name: "no" },
          },
        }, [201]);
      } catch (error) {
        if (!(error instanceof SandboxRuntimeError) || error.code !== "runtime_conflict") throw error;
        runtime = await this.inspectByName(proxyName);
        if (!runtime) throw error;
      }
    }
    if (!runtime) throw new SandboxRuntimeError("egress_proxy_missing");
    const network = await this.client.request<DockerNetwork>("GET", `/networks/${encodeURIComponent(sandboxNetworkName(spec.sandboxId))}`);
    assertSandboxNetwork(network, spec);
    const proxyIp = privateProxyIpv4For(network);
    if (!proxyIp) throw new SandboxRuntimeError("egress_proxy_address_invalid");
    const current = runtime.NetworkSettings?.Networks ?? {};
    const endpoint = current[sandboxNetworkName(spec.sandboxId)];
    if (!endpoint) {
      try {
        await this.client.request("POST", `/networks/${encodeURIComponent(network.Id)}/connect`, {
          Container: runtime.Id,
          EndpointConfig: { Aliases: ["npm-proxy"], IPAMConfig: { IPv4Address: proxyIp } },
        }, [201, 200]);
      } catch (error) {
        if (!(error instanceof SandboxRuntimeError) || error.code !== "runtime_conflict") throw error;
      }
    } else {
      const assignedIp = runtime.State.Running ? endpoint.IPAddress : endpoint.IPAddress || endpoint.IPAMConfig?.IPv4Address;
      if (assignedIp !== proxyIp) throw new SandboxRuntimeError("egress_proxy_address_mismatch");
    }
    await this.client.request("POST", `/containers/${encodeURIComponent(runtime.Id)}/start`, undefined, [204, 304]);
    return this.assertEgressProxy(spec);
  }

  private async assertEgressProxy(spec: SandboxCreateSpec): Promise<string> {
    const runtime = await this.inspectByName(egressProxyContainerName(spec.sandboxId));
    if (!runtime) throw new SandboxRuntimeError("egress_proxy_missing");
    const labels = runtime.Config.Labels ?? {};
    const networks = runtime.NetworkSettings?.Networks ?? {};
    const networkName = sandboxNetworkName(spec.sandboxId);
    const network = await this.client.request<DockerNetwork>("GET", `/networks/${encodeURIComponent(networkName)}`);
    assertSandboxNetwork(network, spec);
    const expectedProxyIp = privateProxyIpv4For(network);
    const endpoint = networks[networkName];
    const proxyIp = endpoint?.IPAddress || (!runtime.State.Running ? endpoint?.IPAMConfig?.IPv4Address : undefined);
    const envAllowlist = (runtime.Config.Env ?? []).find((entry) => entry.startsWith("SANDBOX_EGRESS_ALLOWLIST="));
    const envSandboxId = (runtime.Config.Env ?? []).find((entry) => entry.startsWith("SANDBOX_ID="));
    const checks: Record<string, boolean> = {
      managedLabel: labels["com.meta-game.managed"] === "true",
      runtimeLabel: labels["com.meta-game.runtime-kind"] === "egress-proxy",
      sandboxLabel: labels["com.meta-game.sandbox-id"] === spec.sandboxId,
      projectLabel: labels["com.meta-game.project-id"] === spec.projectId,
      image: runtime.Config.Image === spec.image,
      user: runtime.Config.User === "10000:10000",
      workingDirectory: runtime.Config.WorkingDir === "/opt/meta-game",
      command: JSON.stringify(runtime.Config.Cmd) === JSON.stringify(["node", "/opt/meta-game/egress-proxy.mjs"]),
      allowlist: envAllowlist === `SANDBOX_EGRESS_ALLOWLIST=${(spec.egressAllowlist ?? this.egressAllowlist).join(",")}`,
      sandboxEnvironment: envSandboxId === `SANDBOX_ID=${spec.sandboxId}`,
      unprivileged: runtime.HostConfig.Privileged === false,
      readOnlyRoot: runtime.HostConfig.ReadonlyRootfs === true,
      networkMode: runtime.HostConfig.NetworkMode === sharedEgressNetwork,
      memory: runtime.HostConfig.Memory === 128 * 1024 * 1024 && runtime.HostConfig.MemorySwap === 128 * 1024 * 1024,
      cpuAndPids: runtime.HostConfig.NanoCpus === 250_000_000 && runtime.HostConfig.PidsLimit === 64,
      capabilities: runtime.HostConfig.CapDrop?.includes("ALL") === true,
      noNewPrivileges: runtime.HostConfig.SecurityOpt?.includes("no-new-privileges:true") === true,
      noPorts: Object.keys(runtime.HostConfig.PortBindings ?? {}).length === 0,
      noMounts: (runtime.HostConfig.Binds?.length ?? 0) === 0 && runtime.Mounts.length === 0,
      sharedNetwork: Boolean(networks[sharedEgressNetwork]),
      sandboxNetwork: Boolean(networks[networkName]),
      proxyAlias: runtime.State.Running
        ? endpoint?.Aliases?.includes("npm-proxy") === true
        : Boolean(endpoint?.IPAMConfig?.IPv4Address),
      staticAddress: expectedProxyIp !== undefined && proxyIp === expectedProxyIp,
      networkCount: Object.keys(networks).length === 2,
    };
    const safe = Object.values(checks).every(Boolean);
    const privateProxyIp = isPrivateNetworkIpv4(proxyIp);
    if (!safe || !privateProxyIp) throw new SandboxRuntimeError("egress_proxy_security_invariant_failed");
    return proxyIp;
  }

  private async stopEgressProxy(spec: SandboxCreateSpec): Promise<void> {
    const proxy = await this.inspectByName(egressProxyContainerName(spec.sandboxId));
    if (!proxy) return;
    await this.assertEgressProxy(spec);
    if (proxy.State.Running) await this.client.request("POST", `/containers/${encodeURIComponent(proxy.Id)}/stop?t=5`, undefined, [204, 304]);
  }

  private async removeEgressProxy(spec: SandboxCreateSpec): Promise<void> {
    const proxy = await this.inspectByName(egressProxyContainerName(spec.sandboxId));
    if (!proxy) return;
    await this.assertEgressProxy(spec);
    if (proxy.State.Running) await this.client.request("POST", `/containers/${encodeURIComponent(proxy.Id)}/stop?t=5`, undefined, [204, 304]);
    await this.client.request("DELETE", `/containers/${encodeURIComponent(proxy.Id)}?force=true&v=1`, undefined, [204, 404]);
  }

  private async removeSandboxNetwork(spec: SandboxCreateSpec): Promise<void> {
    const name = sandboxNetworkName(spec.sandboxId);
    let network: DockerNetwork;
    try { network = await this.client.request<DockerNetwork>("GET", `/networks/${encodeURIComponent(name)}`); }
    catch (error) { if (error instanceof SandboxRuntimeError && error.code === "runtime_not_found") return; throw error; }
    assertSandboxNetwork(network, spec);
    await this.client.request("DELETE", `/networks/${encodeURIComponent(network.Id)}`, undefined, [204, 404]);
  }

  async verifyHost(): Promise<void> {
    const info = await this.client.request<DockerInfo>("GET", "/info");
    const engineMajor = Number(/^([0-9]+)\./.exec(info.ServerVersion ?? "")?.[1] ?? 0);
    if (engineMajor < 28) throw new SandboxRuntimeError("docker_engine_28_required_for_isolated_gateway");
    const securityOptions = (info.SecurityOptions ?? []).map((option) => option.toLowerCase());
    if (info.CgroupVersion !== "2") throw new SandboxRuntimeError("cgroups_v2_required");
    if (this.hostRuntimeMode === "rootless") {
      if (!securityOptions.some((option) => option.includes("rootless"))) throw new SandboxRuntimeError("rootless_runtime_required");
      if (info.CgroupDriver !== "systemd") throw new SandboxRuntimeError("systemd_cgroup_driver_required");
    } else if (!(info.OperatingSystem === "Docker Desktop" || (typeof info.OperatingSystem === "string" && info.OperatingSystem.indexOf("Docker Desktop") === 0)) || info.CgroupDriver !== "cgroupfs" || this.workspaceMode !== "tmpfs") {
      throw new SandboxRuntimeError("docker_desktop_security_runtime_required");
    }
    if (!securityOptions.some((option) => option.includes("seccomp"))) throw new SandboxRuntimeError("seccomp_required");
    if (!info.Driver || !["overlay2", "overlayfs", "fuse-overlayfs"].includes(info.Driver)) {
      throw new SandboxRuntimeError("unsupported_runtime_storage_driver");
    }
    const spec: SandboxCreateSpec = {
      sandboxId: randomUUID(),
      projectId: randomUUID(),
      uid: hostCheckUid,
      image: this.image,
      limits: { cpu: hostCheckCpu, memoryMb: hostCheckMemoryMb, diskMb: hostCheckDiskMb, pids: hostCheckPids, commandTimeoutMs: 60_000 },
      egressAllowlist: this.egressAllowlist,
    };
    let probeFailure: unknown;
    try {
      await this.createWithSpec(spec, true);
      const probeProgram = this.hostRuntimeMode === "rootless" ? cgroupProbeProgram : dockerDesktopCgroupProbeProgram;
      const limitsProbe = await this.execWithSpec(spec, ["node", "-e", probeProgram], "", 10_000, true);
      if (limitsProbe.exitCode !== 0) throw new SandboxRuntimeError("sandbox_limits_probe_failed");
      const networkProbe = await this.execWithSpec(spec, ["node", "-e", networkProbeProgram], "", 15_000, true);
      if (networkProbe.exitCode !== 0) throw new SandboxRuntimeError("sandbox_egress_probe_failed");
      const networkProbeRuntime = await this.inspectByName(sandboxContainerName(spec.sandboxId));
      if (!networkProbeRuntime) throw new SandboxRuntimeError("sandbox_network_probe_container_missing");
      if (!networkProbeRuntime.State.Running) {
        await this.client.request("POST", `/containers/${encodeURIComponent(networkProbeRuntime.Id)}/start`, undefined, [204, 304]);
        await this.inspectAndVerify(spec, networkProbeRuntime.Id, true);
      }
      await this.verifyToolRuntime(spec);
    } catch (error) {
      probeFailure = error;
      throw error instanceof SandboxRuntimeError ? error : new SandboxRuntimeError("sandbox_host_probe_failed");
    } finally {
      await this.destroyWithSpec(spec, true).catch((error: unknown) => {
        const cleanupCode = error instanceof SandboxRuntimeError ? error.code : "unknown";
        const probeCode = probeFailure instanceof SandboxRuntimeError ? probeFailure.code : probeFailure ? "unknown" : undefined;
        const message = probeCode ? `probe_${probeCode};cleanup_${cleanupCode}` : cleanupCode;
        throw new SandboxRuntimeError("sandbox_host_probe_cleanup_failed", message);
      });
    }
  }

  private async verifyToolRuntime(spec: SandboxCreateSpec): Promise<void> {
    const write = await this.execWithSpec(
      spec, ["/usr/local/bin/workspace-fs", "write", ".host-check.txt"], "", 5_000, true,
      { stdin: "sandbox-safe\n", maxOutputBytes: 1024 },
    );
    if (write.exitCode !== 0 || write.stdout.trim() !== "13") throw new SandboxRuntimeError("sandbox_filesystem_write_probe_failed");
    const read = await this.execWithSpec(spec, ["/usr/local/bin/workspace-fs", "read", ".host-check.txt"], "", 5_000, true, { maxOutputBytes: 1024 });
    if (read.exitCode !== 0 || read.stdout.trim() !== Buffer.from("sandbox-safe\n").toString("base64")) {
      throw new SandboxRuntimeError("sandbox_filesystem_read_probe_failed");
    }
    const nestedWrite = await this.execWithSpec(
      spec, ["/usr/local/bin/workspace-fs", "write", ".host-check-dir/nested/file.txt"], "", 5_000, true,
      { stdin: "nested-safe", maxOutputBytes: 1024 },
    );
    const nestedRead = await this.execWithSpec(
      spec, ["/usr/local/bin/workspace-fs", "read", ".host-check-dir/nested/file.txt"], "", 5_000, true,
      { maxOutputBytes: 1024 },
    );
    if (nestedWrite.exitCode !== 0 || nestedWrite.stdout.trim() !== "11" ||
      nestedRead.exitCode !== 0 || nestedRead.stdout.trim() !== Buffer.from("nested-safe").toString("base64")) {
      throw new SandboxRuntimeError("sandbox_nested_file_probe_failed");
    }
    const cleanupNested = await this.execWithSpec(
      spec, ["node", "-e", "require('node:fs').rmSync('/workspace/.host-check-dir',{recursive:true})"], "", 5_000, true,
    );
    if (cleanupNested.exitCode !== 0) throw new SandboxRuntimeError("sandbox_nested_file_cleanup_failed");
    const linkSetup = await this.execWithSpec(spec, ["node", "-e", [
      "const fs=require('node:fs');fs.writeFileSync('/tmp/meta-game-host-check-marker','untouched');",
      "fs.symlinkSync('/tmp','/workspace/.host-check-link');",
      "const f=fs.readFileSync('/workspace/.host-check.txt','utf8');if(f!=='sandbox-safe\\n')process.exit(2);",
    ].join("")], "", 5_000, true);
    if (linkSetup.exitCode !== 0) throw new SandboxRuntimeError("sandbox_filesystem_link_probe_failed");
    const escape = await this.execWithSpec(
      spec, ["/usr/local/bin/workspace-fs", "write", ".host-check-link/meta-game-host-check-marker"], "", 5_000, true,
      { stdin: "escaped", maxOutputBytes: 1024 },
    );
    const marker = await this.execWithSpec(spec, ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('/tmp/meta-game-host-check-marker','utf8'))"], "", 5_000, true);
    if (escape.exitCode === 0 || marker.stdout !== "untouched") throw new SandboxRuntimeError("sandbox_filesystem_escape_probe_failed");

    const maliciousLifecycle = JSON.stringify({
      private: true,
      scripts: {
        preinstall: "node -e process.exit(41)",
        build: "node -e \"process.stdout.write('42')\"",
      },
    });
    const manifest = await this.execWithSpec(
      spec, ["/usr/local/bin/workspace-fs", "write", "package.json"], "", 5_000, true,
      { stdin: maliciousLifecycle, maxOutputBytes: 1024 },
    );
    if (manifest.exitCode !== 0) throw new SandboxRuntimeError("sandbox_npm_probe_setup_failed");
    const install = await this.execWithSpec(spec, [
      "npm", "install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund",
      "--cache=/tmp/npm-cache", `--registry=${registryUrl}`, "--", "is-number@7.0.0",
    ], "", Math.min(spec.limits.commandTimeoutMs, 60_000), true, { maxOutputBytes: 16_000 });
    if (install.exitCode !== 0) throw new SandboxRuntimeError("sandbox_npm_install_probe_failed");
    const verify = await this.execWithSpec(spec, ["node", "-e", [
      "const fs=require('node:fs');const test=require('is-number');",
      "if(test('2')!==true||fs.existsSync('/tmp/meta-game-npm-hook-ran'))process.exit(2);",
      "process.stdout.write('ready');",
    ].join("")], "", 5_000, true);
    if (verify.exitCode !== 0 || verify.stdout !== "ready") throw new SandboxRuntimeError("sandbox_npm_lifecycle_probe_failed");
    const build = await this.execWithSpec(spec, ["npm", "run", "build"], "", 15_000, true, { maxOutputBytes: 1024 });
    if (build.exitCode !== 0 || !build.stdout.includes("42")) throw new SandboxRuntimeError("sandbox_build_probe_failed");
    const browserProbe = await this.execWithSpec(
      spec, ["node", "/opt/meta-game/verify-game.mjs"], "", 15_000, true,
      { stdin: JSON.stringify({ probe: true }), maxOutputBytes: 4_096 },
    );
    let browserReady = false;
    try {
      const result = JSON.parse(browserProbe.stdout) as { status?: unknown; checks?: Array<{ status?: unknown }> };
      browserReady = browserProbe.exitCode === 0 && result.status === "passed" && result.checks?.[0]?.status === "passed";
    } catch { /* Fail closed if the pinned sandbox image has no valid browser verifier. */ }
    if (!browserReady) throw new SandboxRuntimeError("sandbox_browser_verifier_probe_failed");
    const output = await this.execWithSpec(
      spec, ["node", "-e", "process.stdout.write('x'.repeat(100000))"], "", 15_000, true, { maxOutputBytes: 1024 },
    );
    if (output.exitCode !== 0 || !output.truncated || Buffer.byteLength(output.stdout) > 1024) {
      throw new SandboxRuntimeError("sandbox_output_limit_probe_failed");
    }
    let timedOut = false;
    try {
      await this.execWithSpec(
        spec,
        ["node", "-e", "const cp=require('node:child_process');cp.spawn('/bin/sleep',['30']);setInterval(()=>{},1000)"],
        "", 1_000, true,
      );
    } catch (error) {
      timedOut = error instanceof SandboxRuntimeError && error.code === "execution_timeout";
    }
    const stopped = await this.inspectByName(sandboxContainerName(spec.sandboxId));
    if (!timedOut || stopped?.State.Running) throw new SandboxRuntimeError("sandbox_timeout_probe_failed");
  }

  async create(spec: SandboxCreateSpec): Promise<SandboxInspection> {
    return this.createWithSpec(spec, false);
  }

  private async createWithSpec(spec: SandboxCreateSpec, hostCheck: boolean): Promise<SandboxInspection> {
    if (spec.image !== this.image) throw new SandboxRuntimeError("sandbox_image_mismatch");
    await this.ensureEgressNetwork();
    await this.ensureSandboxNetwork(spec);
    const proxyIp = await this.ensureEgressProxy(spec);
    const config = buildContainerConfig(
      spec,
      hostCheck,
      proxyIp,
      this.workspaceMode,
      this.hostRuntimeMode === "docker-desktop-security",
    );
    await this.ensureWorkspaceVolume(config.volumeName, config.labels, spec);
    let runtime: { Id: string };
    try {
      runtime = await this.client.request<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(config.containerName)}`, config.body, [201]);
    } catch (error) {
      if (!(error instanceof SandboxRuntimeError) || error.code !== "runtime_conflict") throw error;
      const existing = await this.inspectByName(config.containerName);
      if (!existing) throw error;
      assertContainerSecurity(existing, spec, proxyIp, hostCheck, this.workspaceMode);
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
    const spec = { sandboxId, projectId, uid, image: this.image, limits: this.defaultLimits, egressAllowlist: this.egressAllowlist };
    await this.verifyWorkspaceVolume(spec);
    await this.ensureSandboxNetwork(spec);
    const proxyIp = await this.assertEgressProxy(spec);
    assertContainerSecurity(runtime, spec, proxyIp, false, this.workspaceMode);
    await this.assertSandboxNetworkMembership(spec);
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
    await this.verifyWorkspaceVolume(spec);
    const proxyIp = await this.assertEgressProxy(spec);
    assertContainerSecurity(runtime, spec, proxyIp, hostCheck, this.workspaceMode);
    await this.client.request("POST", `/containers/${encodeURIComponent(runtime.Id)}/stop?t=5`, undefined, [204, 304]);
    await this.stopEgressProxy(spec);
  }

  async destroy(sandboxId: string, projectId: string, uid: number): Promise<void> {
    await this.destroyWithSpec({ sandboxId, projectId, uid, image: this.image, limits: this.defaultLimits });
  }

  private async destroyWithSpec(spec: SandboxCreateSpec, hostCheck = false): Promise<void> {
    const runtime = await this.inspectByName(sandboxContainerName(spec.sandboxId));
    if (runtime) {
      await this.verifyWorkspaceVolume(spec);
      const proxyIp = await this.assertEgressProxy(spec);
      assertContainerSecurity(runtime, spec, proxyIp, hostCheck, this.workspaceMode);
      if (runtime.State.Running) await this.stopWithSpec(spec, hostCheck);
      await this.client.request("DELETE", `/containers/${encodeURIComponent(runtime.Id)}?force=true&v=1`, undefined, [204, 404]);
    }
    await this.removeEgressProxy(spec);
    await this.removeSandboxNetwork(spec);
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

  async exec(
    sandboxId: string,
    projectId: string,
    uid: number,
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
    options: { stdin?: string | Uint8Array; maxOutputBytes?: number } = {},
  ): Promise<SandboxExecResult> {
    return this.execWithSpec({
      sandboxId, projectId, uid, image: this.image, limits: this.defaultLimits,
      egressAllowlist: this.egressAllowlist,
    }, argv, cwd, timeoutMs, false, options);
  }

  private async execWithSpec(
    spec: SandboxCreateSpec,
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
    hostCheck = false,
    options: { stdin?: string | Uint8Array; maxOutputBytes?: number } = {},
  ): Promise<SandboxExecResult> {
    const safeArgv = validateSandboxArgv(argv);
    const workingDir = resolveWorkspaceCwd(cwd);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > spec.limits.commandTimeoutMs) throw new SandboxRuntimeError("invalid_timeout");
    const runtime = await this.inspectByName(sandboxContainerName(spec.sandboxId));
    if (!runtime || !runtime.State.Running) throw new SandboxRuntimeError("sandbox_not_running");
    await this.verifyWorkspaceVolume(spec);
    const proxyIp = await this.assertEgressProxy(spec);
    assertContainerSecurity(runtime, spec, proxyIp, hostCheck, this.workspaceMode);
    const createdAt = performance.now();
    const exec = await this.client.request<{ Id: string }>("POST", `/containers/${encodeURIComponent(runtime.Id)}/exec`, {
      AttachStdin: options.stdin !== undefined,
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
    let outputTruncated = false;
    try {
      const maxOutputBytes = options.maxOutputBytes ?? 64_000;
      const rawLimit = maxOutputBytes * 2 + 65_536;
      const startPath = `/exec/${encodeURIComponent(exec.Id)}/start`;
      const response = await this.client.hijack(
        startPath,
        { Detach: false, Tty: false },
        options.stdin ?? "",
        rawLimit,
        abort.signal,
      );
      if (response.status !== 200 && response.status !== 101) throw new SandboxRuntimeError("sandbox_exec_failed");
      stream = response.body;
      outputTruncated = response.truncated;
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
    const { stdout, stderr, truncated } = decodeDockerStream(stream, options.maxOutputBytes ?? 64_000, outputTruncated);
    const inspection = await this.client.request<{ ExitCode: number }>("GET", `/exec/${encodeURIComponent(exec.Id)}/json`);
    return {
      stdout,
      stderr,
      exitCode: inspection.ExitCode,
      durationMs: Math.max(0, Math.round(performance.now() - createdAt)),
      truncated: truncated || outputTruncated,
    };
  }

  private async ensureWorkspaceVolume(name: string, labels: Record<string, string>, spec: SandboxCreateSpec): Promise<void> {
    if (this.workspaceMode === "tmpfs") return;
    try {
      await this.client.request("POST", "/volumes/create", {
        Name: name,
        Driver: "local",
        Options: {},
        Labels: labels,
      }, [201]);
    } catch (error) {
      if (!(error instanceof SandboxRuntimeError) || error.code !== "runtime_conflict") throw error;
    }
    if (labels["com.meta-game.sandbox-id"] !== spec.sandboxId || labels["com.meta-game.project-id"] !== spec.projectId) {
      throw new SandboxRuntimeError("sandbox_volume_identity_mismatch");
    }
    await this.verifyWorkspaceVolume(spec);
  }

  private async verifyWorkspaceVolume(spec: SandboxCreateSpec): Promise<void> {
    if (this.workspaceMode === "tmpfs") return;
    const volume = await this.client.request<DockerVolume>(
      "GET", `/volumes/${encodeURIComponent(sandboxVolumeName(spec.sandboxId))}`,
    );
    const expectedOptions = {};
    if (volume.Driver !== "local" || volume.Labels?.["com.meta-game.sandbox-id"] !== spec.sandboxId ||
      volume.Labels?.["com.meta-game.managed"] !== "true" ||
      volume.Labels?.["com.meta-game.project-id"] !== spec.projectId ||
      volume.Labels?.["com.meta-game.workspace-limit-mb"] !== String(spec.limits.diskMb) ||
      volume.Labels?.["com.meta-game.workspace-mode"] !== this.workspaceMode ||
      JSON.stringify(volume.Options ?? {}) !== JSON.stringify(expectedOptions)) {
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
    const proxyIp = await this.assertEgressProxy(spec);
    const uid = assertContainerSecurity(inspect, spec, proxyIp, hostCheck, this.workspaceMode);
    await this.assertSandboxNetworkMembership(spec);
    return { sandboxId: spec.sandboxId, state: dockerState(inspect.State), uid, limits: spec.limits };
  }

  private async assertSandboxNetworkMembership(spec: SandboxCreateSpec): Promise<void> {
    const network = await this.client.request<DockerNetwork>("GET", `/networks/${encodeURIComponent(sandboxNetworkName(spec.sandboxId))}`);
    assertSandboxNetwork(network, spec);
    const members = Object.values(network.Containers ?? {}).map(({ Name }) => Name?.replace(/^\//, "")).sort();
    const expected = [sandboxContainerName(spec.sandboxId), egressProxyContainerName(spec.sandboxId)].sort();
    if (members.length !== expected.length || members.some((name, index) => name !== expected[index])) {
      throw new SandboxRuntimeError("sandbox_network_membership_invalid");
    }
  }

}

function decodeDockerStream(body: Buffer, maxOutputBytes: number, responseTruncated = false): { stdout: string; stderr: string; truncated: boolean } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;
  let total = 0;
  let retainedTotal = 0;
  let truncated = responseTruncated;
  while (offset < body.length) {
    if (body.length - offset < 8) {
      if (responseTruncated) break;
      throw new SandboxRuntimeError("runtime_invalid_response");
    }
    const streamType = body[offset];
    const length = body.readUInt32BE(offset + 4);
    offset += 8;
    if ((streamType !== 1 && streamType !== 2) || length > body.length - offset) {
      if (responseTruncated) break;
      throw new SandboxRuntimeError("runtime_invalid_response");
    }
    total += length;
    const chunk = body.subarray(offset, offset + length);
    const output = streamType === 1 ? stdout : stderr;
    const available = Math.max(0, maxOutputBytes - retainedTotal);
    if (available > 0) {
      const kept = chunk.subarray(0, available);
      output.push(kept);
      retainedTotal += kept.length;
    }
    if (chunk.length > available || total > maxOutputBytes) truncated = true;
    offset += length;
  }
  return {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    truncated,
  };
}
