import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseSandboxEnvironment } from "@meta-game/config";

type DockerInfo = {
  SecurityOptions?: string[];
  CgroupVersion?: string;
  CgroupDriver?: string;
  Driver?: string;
};

function fail(code: string): never {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}

function run(command: string, args: string[], maxOutput = 1_000_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxOutput) out.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxOutput) err.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

async function main(): Promise<void> {
  if (process.platform !== "linux") fail("sandbox_host_requires_linux");
  let environment;
  try { environment = parseSandboxEnvironment(process.env); }
  catch { fail("sandbox_configuration_invalid"); }
  if (environment.SANDBOX_DRIVER !== "rootless") fail("sandbox_driver_not_enabled");

  const endpoint = await run("docker", ["context", "inspect", "--format", "{{(index .Endpoints \"docker\").Host}}"]);
  if (endpoint.code !== 0 || !endpoint.stdout.trim().startsWith("unix://") ||
    endpoint.stdout.trim() !== `unix://${environment.SANDBOX_DOCKER_SOCKET}`) {
    fail("rootless_docker_unix_socket_required");
  }
  const infoResult = await run("docker", ["info", "--format", "{{json .}}"]);
  if (infoResult.code !== 0) fail("rootless_docker_unavailable");
  let info: DockerInfo;
  try { info = JSON.parse(infoResult.stdout) as DockerInfo; }
  catch { fail("rootless_docker_info_invalid"); }
  const options = (info.SecurityOptions ?? []).map((option) => option.toLowerCase());
  if (!options.some((option) => option.includes("rootless"))) fail("rootless_docker_required");
  if (info.CgroupVersion !== "2") fail("cgroups_v2_required");
  if (info.CgroupDriver !== "systemd") fail("systemd_cgroup_driver_required");
  if (!options.some((option) => option.includes("seccomp"))) fail("docker_seccomp_required");
  if (!info.Driver || !["overlay2", "overlayfs", "fuse-overlayfs"].includes(info.Driver)) fail("unsupported_rootless_storage_driver");

  const probeProgram = [
  "const fs=require('node:fs');",
  "const stat=fs.statfsSync('/workspace');",
  "const read=(name)=>fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim();",
  "const uidMap=fs.readFileSync('/proc/self/uid_map','utf8').trim().split('\\n').map(line=>line.trim().split(/\\s+/).map(Number));",
  "const mapped=uidMap.find(([inside,,length])=>process.getuid()>=inside&&process.getuid()<inside+length);",
  "const maxRow=uidMap.find(([inside,,length])=>59999>=inside&&59999<inside+length);",
  "const maxHostUid=maxRow&&maxRow[1]+59999-maxRow[0];",
  "const result={uid:process.getuid(),mapped:!!mapped&&mapped[1]+process.getuid()-mapped[0],memory:read('memory.max'),pids:read('pids.max'),cpu:read('cpu.max'),bytes:stat.blocks*stat.bsize};",
  "if(result.uid<10000)process.exit(20);",
  "if(!result.mapped||result.mapped===0)process.exit(29);",
  "if(!maxHostUid||maxHostUid===0)process.exit(30);",
  "if(Number(result.memory)>134217728)process.exit(21);",
  "if(Number(result.pids)>16)process.exit(22);",
  "if(Number(result.bytes)>16777216)process.exit(23);",
  "const cpu=read('cpu.max').split(' ').map(Number);if(!Number.isFinite(cpu[0])||!Number.isFinite(cpu[1])||cpu[1]<=0||cpu[0]/cpu[1]>0.25)process.exit(28);",
  "try{fs.writeFileSync('/etc/sandbox-probe','x');process.exit(24)}catch(e){if(e.code!=='EROFS'&&e.code!=='EACCES')process.exit(25)}",
  "let full=false;for(let n=0;n<32&&!full;n++){try{fs.writeFileSync('/workspace/p'+n,Buffer.alloc(1024*1024))}catch(e){if(e.code==='ENOSPC')full=true;else process.exit(26)}}",
  "if(!full)process.exit(27);",
  ].join("");
  const volumeName = `mg-host-check-${process.pid}-${randomUUID().slice(0, 8)}`;
  const volumeCreate = await run("docker", [
  "volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs",
  "--opt", "o=size=16m,mode=1777,nosuid,nodev,noexec", volumeName,
  ], 16_000);
  if (volumeCreate.code !== 0) fail("sandbox_quota_volume_unavailable");
  let probeCode = 1;
  try {
    const probe = await run("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--storage-opt", "size=16m", "--memory", "128m", "--memory-swap", "128m",
    "--cpus", "0.25", "--pids-limit", "16", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--user", "12345:12345", "--tmpfs", "/tmp:size=8m,noexec,nosuid,nodev",
    "--mount", `type=volume,source=${volumeName},target=/workspace`, "--entrypoint", "node", environment.SANDBOX_IMAGE,
    "-e", probeProgram,
    ], 256_000);
    probeCode = probe.code;
  } finally {
    const cleanup = await run("docker", ["volume", "rm", volumeName], 16_000);
    if (cleanup.code !== 0) fail("sandbox_quota_probe_cleanup_failed");
  }
  if (probeCode !== 0) fail("sandbox_limits_probe_failed");
  const memoryProbe = await run("docker", [
  "run", "--rm", "--network", "none", "--read-only", "--memory", "96m", "--memory-swap", "96m",
  "--pids-limit", "32", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
  "--user", "12345:12345", "--entrypoint", "node", environment.SANDBOX_IMAGE,
  "-e", "const chunks=[];for(let i=0;i<256;i++)chunks.push(Buffer.alloc(1024*1024,1));",
  ], 256_000);
  if (memoryProbe.code !== 137) fail("sandbox_memory_limit_probe_failed");
  const pidsProgram = "const cp=require('node:child_process');const kids=[];let denied=false;for(let i=0;i<64;i++){const p=cp.spawn('/bin/sleep',['10']);p.on('error',e=>{if(e.code==='EAGAIN')denied=true});kids.push(p)}setTimeout(()=>{for(const p of kids)p.kill('SIGKILL');setTimeout(()=>process.exit(denied?0:41),100)},400)";
  const pidsProbe = await run("docker", [
  "run", "--rm", "--network", "none", "--read-only", "--memory", "96m", "--memory-swap", "96m",
  "--pids-limit", "16", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
  "--user", "12345:12345", "--entrypoint", "node", environment.SANDBOX_IMAGE,
  "-e", pidsProgram,
  ], 256_000);
  if (pidsProbe.code !== 0) fail("sandbox_pids_limit_probe_failed");
  const inspectResult = await run("docker", ["image", "inspect", environment.SANDBOX_IMAGE, "--format", "{{json .Config}}"], 100_000);
  if (inspectResult.code !== 0) fail("sandbox_image_unavailable");
  process.stdout.write("sandbox_host_ready linux cgroups=v2 rootless=yes seccomp=yes limits=verified\n");
}

void main().catch(() => fail("sandbox_host_check_failed"));
