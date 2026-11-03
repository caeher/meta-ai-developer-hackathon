import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SandboxEnvironmentSchema } from "../packages/config/src/sandbox-environment";

const offlineFiles = [
  "tests/security/network.test.ts",
  "tests/security/filesystem.test.ts",
  "tests/projects-api.test.ts",
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

runVitest(offlineFiles);
if (offline) process.exit(0);

if (process.platform !== "linux") fail("security_host_requires_linux");
if (process.env.SECURITY_TEST_ENABLED !== "true") fail("security_host_tests_not_enabled");
if (process.env.SECURITY_TEST_DISPOSABLE_HOST !== "1") fail("security_host_must_be_disposable");
if (process.env.SANDBOX_DRIVER !== "rootless") fail("security_rootless_driver_required");

const securityEnvironment = SandboxEnvironmentSchema.omit({ SANDBOX_CONTROLLER_TOKEN: true })
  .passthrough()
  .safeParse(process.env);
if (!securityEnvironment.success) fail("security_sandbox_configuration_invalid");

const sandboxImage = securityEnvironment.data.SANDBOX_IMAGE;
if (!sandboxImage.includes("@sha256:")) fail("security_sandbox_image_digest_required");

process.stdout.write("security_host_gate=passed platform=linux driver=rootless isolated=explicit\n");
runVitest(["tests/security/hostile-runtime.test.ts"]);
