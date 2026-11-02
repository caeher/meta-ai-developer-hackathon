import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";

const port = 4173;
const pidPath = "/tmp/meta-game-dev-server.pid";
const outPath = "/tmp/meta-game-dev-server.stdout.log";
const errPath = "/tmp/meta-game-dev-server.stderr.log";
const maxLogBytes = 6_000;

function appendBounded(path, chunk) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    const available = Math.max(0, maxLogBytes - size);
    if (available > 0) writeSync(fd, chunk.subarray(0, available));
  } finally { closeSync(fd); }
}

function removeFile(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function readTail(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(maxLogBytes, size);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString("utf8");
  } finally { closeSync(fd); }
}

function readPid() {
  let fd;
  try { fd = openSync(pidPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return null; }
  try {
    const buffer = Buffer.alloc(32);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const pid = Number(buffer.toString("utf8", 0, length).trim());
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } finally { closeSync(fd); }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function writePid(pid) {
  const fd = openSync(pidPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, `${pid}\n`); } finally { closeSync(fd); }
}

function start() {
  const existing = readPid();
  if (existing && isAlive(existing)) throw new Error("dev_server_already_running");
  removeFile(pidPath);
  removeFile(outPath);
  removeFile(errPath);
  closeSync(openSync(outPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  closeSync(openSync(errPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "supervise"], {
    cwd: "/workspace",
    detached: true,
    env: { ...process.env, CI: "1", npm_config_update_notifier: "false" },
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("dev_server_spawn_failed");
  try { writePid(child.pid); }
  catch (error) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    throw error;
  }
  child.unref();
  process.stdout.write(`${JSON.stringify({ pid: child.pid, port })}\n`);
}

function supervise() {
  const server = spawn("npm", ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(port)], {
    cwd: "/workspace",
    env: { ...process.env, CI: "1", npm_config_update_notifier: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => appendBounded(outPath, Buffer.from(chunk)));
  server.stderr.on("data", (chunk) => appendBounded(errPath, Buffer.from(chunk)));
  const stop = () => {
    if (server.exitCode === null) server.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  server.once("error", (error) => appendBounded(errPath, Buffer.from(`${error.message}\n`)));
  server.once("exit", () => process.exit());
}

async function health() {
  const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(750) });
  const healthy = response.status === 200 && response.headers.get("content-type")?.toLowerCase().includes("text/html");
  await response.body?.cancel();
  if (!healthy) throw new Error("dev_server_unhealthy");
  process.stdout.write("healthy\n");
}

function logs() {
  const pid = readPid();
  process.stdout.write(`${JSON.stringify({
    status: pid && isAlive(pid) ? "running" : "stopped",
    stdout: readTail(outPath),
    stderr: readTail(errPath),
  })}\n`);
}

function stop() {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* Already stopped. */ } }
  }
  removeFile(pidPath);
  process.stdout.write("stopped\n");
}

const operation = process.argv[2];
try {
  if (operation === "start") start();
  else if (operation === "supervise") supervise();
  else if (operation === "health") await health();
  else if (operation === "logs") logs();
  else if (operation === "stop") stop();
  else throw new Error("invalid_operation");
} catch (error) {
  const code = error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message) ? error.message : "server_manager_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 2;
}
