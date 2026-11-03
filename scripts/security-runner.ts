import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SandboxEnvironmentSchema } from "../packages/config/src/sandbox-environment";

const offlineFiles = [
  "tests/security/network.test.ts",
  "tests/security/filesystem.test.ts",
  "tests/assets/image-generator.test.ts",
  "tests/assets/image-pipeline.test.ts",
  "tests/projects-api.test.ts",
  "tests/worker-queue.test.ts",
  "tests/unit/run-handlers.test.ts",
  "tests/unit/run-events-handler.test.ts",
  "tests/versions-api.test.ts",
  "tests/publications-api.test.ts",
  "tests/auth.test.ts",
  "tests/storage.test.ts",
  "tests/preview-protocol.test.ts",
  "tests/integration/preview-gateway.test.ts",
  "tests/sandbox.test.ts",
  "tests/publishing-origin.test.ts",
];

const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const offline = process.argv.includes("--offline");
const composeRuntime = process.argv.includes("--compose-runtime");
const composeRunner = process.env.SECURITY_TEST_COMPOSE_RUNNER === "true";

function fail(code: string): never {
  process.stderr.write(`${code}\n`);
  process.exit(2);
}

function runVitest(files: readonly string[]): void {
  const result = spawnSync(process.execPath, [vitestCli, "run", ...files], {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) fail("security_vitest_unavailable");
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!offline && !composeRuntime && !composeRunner) {
  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const composeArgs = [
    "compose", "--file", "infra/compose.yml", "--env-file", "infra/env.example", "--profile", "security",
  ];
  const imageBuild = spawnSync(docker, [...composeArgs, "run", "--build", "--rm", "security-sandbox-image"], {
    cwd: process.cwd(), stdio: "inherit", windowsHide: true, shell: false,
  });
  if (imageBuild.error) fail("security_compose_unavailable");
  if (imageBuild.status !== 0) process.exit(imageBuild.status ?? 1);
  const runtime = spawnSync(docker, [...composeArgs, "run", "--build", "--rm", "security-runner"], {
    cwd: process.cwd(), stdio: "inherit", windowsHide: true, shell: false,
  });
  if (runtime.error) fail("security_compose_unavailable");
  process.exit(runtime.status ?? 1);
}

runVitest(offlineFiles);
if (offline) process.exit(0);

if (process.platform !== "linux") fail("security_host_requires_linux");
if (process.env.SECURITY_TEST_ENABLED !== "true") fail("security_host_tests_not_enabled");
if (process.env.SECURITY_TEST_DISPOSABLE_HOST !== "1") fail("security_host_must_be_disposable");
if (process.env.SANDBOX_DRIVER !== "rootless") fail("security_rootless_driver_required");
if (!composeRunner || process.env.SANDBOX_DOCKER_SOCKET !== "/var/run/docker.sock") fail("security_compose_runtime_required");

const securityEnvironment = SandboxEnvironmentSchema.omit({ SANDBOX_CONTROLLER_TOKEN: true })
  .extend({ SANDBOX_IMAGE: z.string().min(1) })
  .passthrough()
  .safeParse(process.env);
if (!securityEnvironment.success) fail("security_sandbox_configuration_invalid");

const sandboxImage = securityEnvironment.data.SANDBOX_IMAGE;
if (!sandboxImage.includes("@sha256:") && sandboxImage !== "meta-game-sandbox:security") fail("security_sandbox_image_digest_required");

process.stdout.write("security_host_gate=passed platform=linux runtime=docker-desktop-compose sandbox_uid=nonroot disposable=explicit\n");
runVitest(["tests/security/hostile-runtime.test.ts"]);
