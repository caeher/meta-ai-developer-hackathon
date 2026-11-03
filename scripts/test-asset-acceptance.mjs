import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
const environment = {
  ...process.env,
  ISSUE_31_ASSET_PREVIEW_ARTIFACT: artifactPath,
  ISSUE_32_TILESET_PREVIEW_ARTIFACT: tilesetArtifactPath,
  ISSUE_33_TILEMAP_PREVIEW_ARTIFACT: tilemapArtifactPath,
  ISSUE_34_SPRITESHEET_PREVIEW_ARTIFACT: spritesheetArtifactPath,
  ISSUE_36_SPRITESHEET_PREVIEW_ARTIFACT: issue36SpritesheetArtifactPath,
  ISSUE_36_TILEMAP_PREVIEW_ARTIFACT: issue36TilemapArtifactPath,
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

try {
  const integrationStatus = run([join(repositoryRoot, "scripts/test-integration.mjs")]);
  if (integrationStatus !== 0) {
    process.exitCode = integrationStatus;
  } else {
    process.exitCode = run([
      join(repositoryRoot, "node_modules/playwright/cli.js"),
      "test",
      "--config",
      "tests/assets/playwright.config.ts",
    ]);
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
