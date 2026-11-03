import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxEnvironmentSchema } from "../../packages/config/src/sandbox-environment";
import { RootlessDockerDriver } from "../../packages/sandbox/src/rootless";
import type { SandboxCreateSpec, SandboxLimits } from "../../packages/sandbox/src/driver";

const enabled = process.platform === "linux" &&
  process.env.SECURITY_TEST_ENABLED === "true" &&
  process.env.SECURITY_TEST_DISPOSABLE_HOST === "1" &&
  process.env.SANDBOX_DRIVER === "rootless";

const hostileLimits: SandboxLimits = {
  cpu: 0.25,
  memoryMb: 256,
  diskMb: 128,
  pids: 16,
  commandTimeoutMs: 10_000,
};

let driver: RootlessDockerDriver;

describe.skipIf(!enabled)("aislamiento hostil con Docker rootless real", () => {
  let sandboxes: SandboxCreateSpec[] = [];

  beforeAll(async () => {
    const parsed = SandboxEnvironmentSchema.omit({ SANDBOX_CONTROLLER_TOKEN: true })
      .passthrough()
      .parse(process.env);
    if (parsed.SANDBOX_DRIVER !== "rootless") throw new Error("security_rootless_driver_required");

    driver = new RootlessDockerDriver(
      parsed.SANDBOX_DOCKER_SOCKET,
      parsed.SANDBOX_IMAGE,
      hostileLimits,
      parsed.SANDBOX_EGRESS_ALLOWLIST,
    );
    await driver.verifyHost();

    const usedUids = new Set<number>();
    const candidates = [0, 1].map(() => {
      let uid: number;
      do { uid = randomInt(10_000, 60_000); } while (usedUids.has(uid));
      usedUids.add(uid);
      return {
        sandboxId: randomUUID(),
        projectId: randomUUID(),
        uid,
        image: parsed.SANDBOX_IMAGE,
        limits: hostileLimits,
        egressAllowlist: parsed.SANDBOX_EGRESS_ALLOWLIST,
      };
    });
    sandboxes = [];
    for (const sandbox of candidates) {
      await driver.create(sandbox);
      sandboxes.push(sandbox);
    }
  }, 180_000);

  afterAll(async () => {
    if (!driver) return;
    const results = await Promise.allSettled(sandboxes.map((sandbox) =>
      driver.destroy(sandbox.sandboxId, sandbox.projectId, sandbox.uid)));
    if (results.some((result) => result.status === "rejected")) throw new Error("security_sandbox_cleanup_failed");
  });

  it("separa los workspaces de A y B para lectura y escritura", async () => {
    const [ownerA, ownerB] = sandboxes;
    if (!ownerA || !ownerB) throw new Error("security_sandbox_setup_missing");
    const path = "private-evidence.txt";
    const markerA = `owner-a-${randomUUID()}`;
    const markerB = `owner-b-${randomUUID()}`;

    expect((await writeWorkspaceFile(ownerA, path, markerA)).exitCode).toBe(0);
    expect((await readWorkspaceFile(ownerB, path)).exitCode).not.toBe(0);
    expect((await writeWorkspaceFile(ownerB, path, markerB)).exitCode).toBe(0);
    const aReadback = await readWorkspaceFile(ownerA, path);
    expect(aReadback.exitCode).toBe(0);
    expect(aReadback.stdout.trim()).toBe(Buffer.from(markerA).toString("base64"));
  }, 30_000);

  it("no monta sockets/credenciales del control plane y mantiene UID, capabilities y rootfs restringidos", async () => {
    const sandbox = sandboxes[0];
    if (!sandbox) throw new Error("security_sandbox_setup_missing");
    const probe = [
      "const fs=require('node:fs');",
      "const sensitiveName=/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE|REDIS|S3_|PRIVATE)/i;",
      "const envLeak=Object.keys(process.env).some(name=>sensitiveName.test(name));",
      "const socketLeak=['/var/run/docker.sock','/run/docker.sock','/run/user/1000/docker.sock'].some(path=>fs.existsSync(path));",
      "const status=fs.readFileSync('/proc/self/status','utf8');",
      "const capabilities=/^CapEff:\\s*([0-9a-f]+)$/mi.exec(status)?.[1];",
      "let rootReadOnly=false;try{fs.writeFileSync('/etc/security-probe','x')}catch(error){rootReadOnly=['EROFS','EACCES'].includes(error.code)}",
      "if(process.getuid()===0||envLeak||socketLeak||capabilities!=='0000000000000000'||!rootReadOnly)process.exit(31);",
      "process.stdout.write('confined');",
    ].join("");
    const result = await runNode(sandbox, probe);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("confined");
  }, 30_000);

  it("bloquea SSRF directo a loopback, metadata, LAN e IPv6 y niega DNS saliente", async () => {
    const sandbox = sandboxes[0];
    if (!sandbox) throw new Error("security_sandbox_setup_missing");
    const probe = [
      "const {Resolver}=require('node:dns');",
      "(async()=>{",
      "const targets=['http://127.0.0.1:80/','http://169.254.169.254/latest/meta-data/','http://10.0.0.1/','http://[fd00::1]/','http://[::ffff:127.0.0.1]/','http://[::ffff:169.254.169.254]/'];",
      "const blocked=await Promise.all(targets.map(url=>fetch(url,{signal:AbortSignal.timeout(700)}).then(()=>false,()=>true)));",
      "const resolver=new Resolver();resolver.setServers(['127.0.0.11']);",
      "const dnsBlocked=await new Promise(resolve=>resolver.resolve4('registry.npmjs.org',error=>resolve(Boolean(error))));",
      "if(!blocked.every(Boolean)||!dnsBlocked)process.exit(32);",
      "process.stdout.write('egress-confined');",
      "})().catch(()=>process.exit(33));",
    ].join("");
    const result = await runNode(sandbox, probe);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("egress-confined");
  }, 30_000);

  it("impide que una carrera de symlinks saque escrituras de /workspace", async () => {
    const sandbox = sandboxes[0];
    if (!sandbox) throw new Error("security_sandbox_setup_missing");
    const leaf = `escape-${randomUUID()}`;
    for (const path of ["../etc/passwd", "/etc/passwd", `race/../../tmp/${leaf}`]) {
      const traversal = await driver.exec(
        sandbox.sandboxId,
        sandbox.projectId,
        sandbox.uid,
        ["/usr/local/bin/workspace-fs", "read", path],
        "",
        5_000,
        { maxOutputBytes: 1_024 },
      );
      expect(traversal.exitCode).not.toBe(0);
    }
    const probe = [
      "const fs=require('node:fs');const cp=require('node:child_process');",
      "const base='/workspace/race';const target=`/tmp/" + leaf + "`;",
      "fs.mkdirSync(base,{recursive:true});let flip=false;let errors=0;",
      "const toggle=()=>{try{fs.rmSync(base,{recursive:true,force:true});if(flip)fs.mkdirSync(base,{recursive:true});else fs.symlinkSync('/tmp',base);flip=!flip}catch{errors++}};",
      "const timer=setInterval(toggle,1);const jobs=[];",
      "for(let i=0;i<8;i++)jobs.push(new Promise(resolve=>{const child=cp.spawn('/usr/local/bin/workspace-fs',['write','race/" + leaf + "'],{stdio:['pipe','ignore','ignore']});child.once('error',()=>resolve());child.once('close',()=>resolve());child.stdin.end('race');}));",
      "Promise.all(jobs).then(()=>{clearInterval(timer);try{fs.rmSync(base,{recursive:true,force:true})}catch{};if(fs.existsSync(target))process.exit(34);process.stdout.write('race-confined')}).catch(()=>process.exit(35));",
    ].join("");
    const result = await runNode(sandbox, probe);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("race-confined");
  }, 30_000);

  it("instala fixtures con lifecycle deshabilitado y no ejecuta el hook hostil", async () => {
    const sandbox = sandboxes[0];
    if (!sandbox) throw new Error("security_sandbox_setup_missing");
    const manifest = await readFile(new URL("../fixtures/hostile-games/package-lifecycle.json", import.meta.url), "utf8");
    const saved = await driver.exec(
      sandbox.sandboxId,
      sandbox.projectId,
      sandbox.uid,
      ["/usr/local/bin/workspace-fs", "write", "package.json"],
      "",
      5_000,
      { stdin: manifest, maxOutputBytes: 1_024 },
    );
    expect(saved.exitCode).toBe(0);

    const install = await driver.exec(
      sandbox.sandboxId,
      sandbox.projectId,
      sandbox.uid,
      ["npm", "install", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund", "--cache=/tmp/npm-cache"],
      "",
      10_000,
      { maxOutputBytes: 4_096 },
    );
    expect(install.exitCode).toBe(0);
    const verify = await runNode(sandbox, "if(require('node:fs').existsSync('/tmp/security-lifecycle-ran'))process.exit(40);process.stdout.write('hook-suppressed')");
    expect(verify.exitCode).toBe(0);
    expect(verify.stdout).toBe("hook-suppressed");
  }, 30_000);

  it("aplica límites reales de cgroups y cuota dura del workspace", async () => {
    const [ownerA, ownerB] = sandboxes;
    if (!ownerA || !ownerB) throw new Error("security_sandbox_setup_missing");
    const cgroups = [
      "const fs=require('node:fs');const read=name=>fs.readFileSync('/sys/fs/cgroup/'+name,'utf8').trim();",
      "const memory=Number(read('memory.max'));const pids=Number(read('pids.max'));const cpu=read('cpu.max').split(/\\s+/).map(Number);",
      "if(memory!==268435456||pids!==16||!Number.isFinite(cpu[0])||!Number.isFinite(cpu[1])||cpu[0]/cpu[1]>0.25)process.exit(36);",
      "process.stdout.write('limits-applied');",
    ].join("");
    const cgroupResult = await runNode(ownerA, cgroups);
    expect(cgroupResult.exitCode).toBe(0);
    expect(cgroupResult.stdout).toBe("limits-applied");

    const quota = [
      "const fs=require('node:fs');const fd=fs.openSync('/workspace/quota.bin','w');const block=Buffer.alloc(1024*1024,1);let written=0;let full=false;",
      "for(let index=0;index<132&&!full;index++){try{written+=fs.writeSync(fd,block)}catch(error){if(error.code==='ENOSPC')full=true;else throw error}}",
      "fs.closeSync(fd);if(!full||written<126*1024*1024||written>129*1024*1024)process.exit(37);",
      "process.stdout.write(String(written));",
    ].join("");
    const quotaResult = await runNode(ownerA, quota);
    expect(quotaResult.exitCode).toBe(0);
    expect(Number(quotaResult.stdout)).toBeGreaterThanOrEqual(126 * 1024 * 1024);
    expect(Number(quotaResult.stdout)).toBeLessThanOrEqual(129 * 1024 * 1024);
    const quotaNeighbor = await runNode(ownerB, "process.stdout.write('neighbor-responsive')");
    expect(quotaNeighbor.exitCode).toBe(0);
    expect(quotaNeighbor.stdout).toBe("neighbor-responsive");
  }, 60_000);

  it("contiene CPU, memoria y PIDs de un sandbox mientras el vecino sigue disponible", async () => {
    const [ownerA, ownerB] = sandboxes;
    if (!ownerA || !ownerB) throw new Error("security_sandbox_setup_missing");

    const cpuProgram = [
      "const fs=require('node:fs');const read=()=>Number(/^nr_throttled\\s+(\\d+)$/m.exec(fs.readFileSync('/sys/fs/cgroup/cpu.stat','utf8'))?.[1]??0);",
      "const before=read();const until=Date.now()+2500;let value=0;while(Date.now()<until)value=Math.imul(value+1,17);",
      "if(read()<=before)process.exit(38);process.stdout.write('cpu-throttled');",
    ].join("");
    const cpuPressure = runNode(ownerA, cpuProgram, 8_000);
    await delay(150);
    const cpuNeighbor = await runNode(ownerB, "process.stdout.write('neighbor-responsive')");
    const cpuResult = await cpuPressure;
    expect(cpuResult.exitCode).toBe(0);
    expect(cpuResult.stdout).toBe("cpu-throttled");
    expect(cpuNeighbor.exitCode).toBe(0);
    expect(cpuNeighbor.stdout).toBe("neighbor-responsive");

    const memoryProgram = "const chunks=[];for(let index=0;index<512;index++)chunks.push(Buffer.alloc(1024*1024,1));";
    const memoryPressure = driver.exec(
      ownerA.sandboxId,
      ownerA.projectId,
      ownerA.uid,
      ["node", "-e", memoryProgram],
      "",
      8_000,
      { maxOutputBytes: 1_024 },
    );
    await delay(150);
    const memoryNeighbor = await runNode(ownerB, "process.stdout.write('neighbor-responsive')");
    const memoryResult = await memoryPressure;
    expect(memoryResult.exitCode).toBe(137);
    expect(memoryNeighbor.exitCode).toBe(0);
    expect(memoryNeighbor.stdout).toBe("neighbor-responsive");
    expect((await runNode(ownerA, "process.stdout.write('sandbox-alive')")).stdout).toBe("sandbox-alive");

    const pidProgram = [
      "const {spawn}=require('node:child_process');const fs=require('node:fs');const children=[];",
      "const maxEvents=()=>Number(/^max\\s+(\\d+)$/m.exec(fs.readFileSync('/sys/fs/cgroup/pids.events','utf8'))?.[1]??0);",
      "(async()=>{const initial=maxEvents();let blocked=false;",
      "try{for(let index=0;index<64;index++){const started=await new Promise(resolve=>{const child=spawn('/bin/sleep',['20'],{stdio:'ignore'});child.once('spawn',()=>{children.push(child);resolve(true)});child.once('error',()=>resolve(false))});if(!started){blocked=true;break}}",
      "if(blocked)await new Promise(resolve=>setTimeout(resolve,1250));}",
      "finally{for(const child of children)child.kill('SIGTERM');await Promise.all(children.map(child=>new Promise(resolve=>child.once('close',resolve))))}",
      "if(!blocked||children.length<4||children.length>=16||maxEvents()<=initial)process.exit(39);process.stdout.write('pid-capped');})().catch(()=>process.exit(40));",
    ].join("");
    const pidPressure = runNode(ownerA, pidProgram, 8_000);
    await delay(250);
    const pidNeighbor = await runNode(ownerB, "process.stdout.write('neighbor-responsive')");
    const pidResult = await pidPressure;
    expect(pidResult.exitCode).toBe(0);
    expect(pidResult.stdout).toBe("pid-capped");
    expect(pidNeighbor.exitCode).toBe(0);
    expect(pidNeighbor.stdout).toBe("neighbor-responsive");
    expect((await runNode(ownerA, "process.stdout.write('sandbox-alive')")).stdout).toBe("sandbox-alive");
  }, 60_000);

  it("detiene un proceso que supera el límite de tiempo", async () => {
    const sandbox = sandboxes[0];
    if (!sandbox) throw new Error("security_sandbox_setup_missing");
    await expect(driver.exec(
      sandbox.sandboxId,
      sandbox.projectId,
      sandbox.uid,
      ["node", "-e", "while(true){}"],
      "",
      1_000,
    )).rejects.toMatchObject({ code: "execution_timeout" });
  }, 30_000);
});

async function writeWorkspaceFile(sandbox: SandboxCreateSpec, path: string, content: string) {
  return driver.exec(
    sandbox.sandboxId,
    sandbox.projectId,
    sandbox.uid,
    ["/usr/local/bin/workspace-fs", "write", path],
    "",
    5_000,
    { stdin: content, maxOutputBytes: 1_024 },
  );
}

async function readWorkspaceFile(sandbox: SandboxCreateSpec, path: string) {
  return driver.exec(
    sandbox.sandboxId,
    sandbox.projectId,
    sandbox.uid,
    ["/usr/local/bin/workspace-fs", "read", path],
    "",
    5_000,
    { maxOutputBytes: 1_024 },
  );
}

async function runNode(sandbox: SandboxCreateSpec, program: string, timeoutMs = 5_000) {
  return driver.exec(
    sandbox.sandboxId,
    sandbox.projectId,
    sandbox.uid,
    ["node", "-e", program],
    "",
    timeoutMs,
    { maxOutputBytes: 1_024 },
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
