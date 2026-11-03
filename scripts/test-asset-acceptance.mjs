import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "meta-game-issue31-"));
const artifactPath = join(temporaryDirectory, "sprite-edit.json");
const tilesetArtifactPath = join(temporaryDirectory, "tileset.json");
const tilemapArtifactPath = join(temporaryDirectory, "tilemap.json");
const spritesheetArtifactPath = join(temporaryDirectory, "spritesheet.json");
const issue36SpritesheetArtifactPath = join(temporaryDirectory, "issue36-spritesheet.json");
const issue36TilemapArtifactPath = join(temporaryDirectory, "issue36-tilemap.json");
const issue37DockerPreviewReportPath = join(temporaryDirectory, "issue37-docker-preview.json");
const environment = {
  ...process.env,
  ISSUE_31_ASSET_PREVIEW_ARTIFACT: artifactPath,
  ISSUE_32_TILESET_PREVIEW_ARTIFACT: tilesetArtifactPath,
  ISSUE_33_TILEMAP_PREVIEW_ARTIFACT: tilemapArtifactPath,
  ISSUE_34_SPRITESHEET_PREVIEW_ARTIFACT: spritesheetArtifactPath,
  ISSUE_36_SPRITESHEET_PREVIEW_ARTIFACT: issue36SpritesheetArtifactPath,
  ISSUE_36_TILEMAP_PREVIEW_ARTIFACT: issue36TilemapArtifactPath,
  ISSUE_37_ASSET_ACCEPTANCE: "1",
  ISSUE_37_DOCKER_PREVIEW_REPORT: issue37DockerPreviewReportPath,
};

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw new Error("No se pudo iniciar la aceptacion local de assets.");
  return result.status ?? 1;
}

function buildDockerSandboxImage() {
  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const result = spawnSync(docker, [
    "compose", "-f", join(repositoryRoot, "infra/compose.yml"), "--profile", "security", "build", "security-sandbox-image",
  ], { cwd: repositoryRoot, env: environment, stdio: "inherit", windowsHide: true, shell: false });
  if (result.error) throw new Error("No se pudo preparar la imagen desechable del sandbox.");
  return result.status ?? 1;
}

try {
  const sandboxImageStatus = buildDockerSandboxImage();
  if (sandboxImageStatus !== 0) {
    process.exitCode = sandboxImageStatus;
  } else {
    const integrationStatus = run([join(repositoryRoot, "scripts/test-integration.mjs")]);
    if (integrationStatus !== 0) {
      process.exitCode = integrationStatus;
      if (existsSync(issue37DockerPreviewReportPath)) {
        const failure = JSON.parse(readFileSync(issue37DockerPreviewReportPath, "utf8"));
        if (typeof failure.failure === "string") console.error(`Issue #37 Docker preview failed at ${failure.failure}.`);
      }
    } else {
      const previewStatus = run([
        join(repositoryRoot, "node_modules/playwright/cli.js"),
        "test",
        "--config",
        "tests/assets/playwright.config.ts",
      ]);
      process.exitCode = previewStatus;
      if (previewStatus === 0) {
        const dockerPreview = JSON.parse(readFileSync(issue37DockerPreviewReportPath, "utf8"));
        writeFileSync(join(repositoryRoot, "docs/evidence/issue-37-docker-preview.json"), `${JSON.stringify(dockerPreview, null, 2)}\n`, "utf8");
      }
    }
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
