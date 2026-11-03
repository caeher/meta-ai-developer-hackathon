import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxExecResult } from "../../packages/sandbox/src/driver";
import { RootlessDockerDriver } from "../../packages/sandbox/src/rootless";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

function requireSuccess(result: SandboxExecResult, code: string): SandboxExecResult {
  if (result.exitCode !== 0 || result.truncated) {
    const details = `${result.stdout}\n${result.stderr}`.trim();
    const category = classifyFailure(details);
    const errorCode = `${code}_${category}`;
    const lines = details.split(/\r?\n/);
    const diagnosticIndex = lines.findIndex((line) => /issue_37_browser_check_|Error:|ERR_[A-Z_]+|failed to load config|error during build/i.test(line));
    const diagnostic = (diagnosticIndex >= 0 ? lines.slice(diagnosticIndex, diagnosticIndex + 4).join(" | ") : "no_safe_diagnostic")
      .replace(/[^A-Za-z0-9 .,()/@:_-]/g, "").slice(0, 260);
    throw Object.assign(new Error(errorCode), { code: errorCode, diagnostic });
  }
  return result;
}

function classifyFailure(details: string): string {
  const browserStage = /issue_37_browser_check_([a-z0-9_]+)/i.exec(details)?.[1];
  if (browserStage) return `stage_${browserStage.toLowerCase().slice(0, 40)}`;
  const npmCode = /npm (?:error|err!) code\s+([A-Z0-9_]+)/i.exec(details)?.[1];
  if (npmCode) return `npm_${npmCode.toLowerCase()}`;
  if (/cannot find package|cannot find module|module not found/i.test(details)) {
    if (/esbuild/i.test(details)) return "esbuild_missing";
    if (/rollup/i.test(details)) return "rollup_missing";
    return "module_missing";
  }
  if (/failed to resolve import|could not resolve/i.test(details)) return "import_missing";
  if (/failed to load config|vite\.config/i.test(details)) return "vite_config";
  if (/not enough space|no space left on device|ENOSPC/i.test(details)) return "disk_quota";
  const httpStatus = /(?:http|status(?: code)?|response)\D{0,8}(40[13479]|429|5\d\d)\b/i.exec(details)?.[1];
  if (httpStatus) return `http_${httpStatus}`;
  if (/no matching version found|notarget/i.test(details)) return "package_version";
  const cases: Array<readonly [string, RegExp]> = [
    ["dns", /\b(?:EAI_AGAIN|ENOTFOUND)\b/i],
    ["timeout", /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT)\b/i],
    ["connection", /\b(?:ECONNREFUSED|ECONNRESET)\b/i],
    ["forbidden", /\b(?:403|407|forbidden)\b/i],
    ["tls", /\b(?:certificate|CERT_|TLS|SSL)\b/i],
    ["permission", /\b(?:EACCES|EPERM)\b/i],
    ["network", /\b(?:ENETUNREACH|ENETDOWN)\b/i],
  ];
  return cases.find(([, pattern]) => pattern.test(details))?.[0] ?? "other";
}

function collectLockedViteRuntimeArchive(): Buffer {
  const modulesRoot = join(repositoryRoot, "node_modules");
  const packagePath = (name: string, fromDirectory: string): string | undefined => {
    let directory = resolve(fromDirectory);
    while (directory.startsWith(repositoryRoot)) {
      const candidate = join(directory, "node_modules", ...name.split("/"), "package.json");
      if (existsSync(candidate)) return dirname(candidate);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const rootCandidate = join(modulesRoot, ...name.split("/"), "package.json");
    return existsSync(rootCandidate) ? dirname(rootCandidate) : undefined;
  };

  const viteDirectory = packagePath("vite", repositoryRoot);
  const phaserPackage = JSON.parse(readFileSync(join(modulesRoot, "phaser", "package.json"), "utf8")) as { version?: string };
  if (!viteDirectory) throw new Error("issue_37_locked_vite_missing");
  const vitePackage = JSON.parse(readFileSync(join(viteDirectory, "package.json"), "utf8")) as { version?: string };
  if (vitePackage.version !== "7.3.7" || phaserPackage.version !== "3.90.0") {
    throw new Error("issue_37_locked_asset_dependency_version_mismatch");
  }

  const included = new Set<string>();
  const visit = (name: string, fromDirectory: string, optional: boolean): void => {
    const directory = packagePath(name, fromDirectory);
    if (!directory) {
      if (optional) return;
      throw new Error("issue_37_locked_vite_dependency_missing");
    }
    const archivePath = relative(repositoryRoot, directory).split(sep).join("/");
    if (!archivePath.startsWith("node_modules/")) throw new Error("issue_37_locked_vite_dependency_path_invalid");
    if (included.has(archivePath)) return;
    included.add(archivePath);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, directory, false);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) visit(dependency, directory, true);
  };
  visit("vite", repositoryRoot, false);

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "issue-37-vite-"));
  try {
    const archivePath = join(temporaryDirectory, "vite-runtime.tar.gz");
    execFileSync("tar", ["-czf", archivePath, "-C", repositoryRoot, ...included], { stdio: "pipe" });
    const archive = readFileSync(archivePath);
    return archive;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runIssue37DockerPreview(workspaceFiles: ReadonlyMap<string, string | Uint8Array>) {
  const sandboxId = randomUUID();
  const projectId = randomUUID();
  const uid = 10_000;
  const image = "meta-game-sandbox:security";
  const limits = { cpu: 1, memoryMb: 1024, diskMb: 2048, pids: 128, commandTimeoutMs: 120_000 };
  const socketPath = process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock";
  const driver = new RootlessDockerDriver(socketPath, image, limits, [], {
    hostRuntimeMode: "docker-desktop-security",
    workspaceMode: "tmpfs",
  });

  async function write(path: string, value: string | Uint8Array): Promise<void> {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    const result = await driver.exec(sandboxId, projectId, uid, ["/usr/local/bin/workspace-fs", "write", path], "", 30_000, {
      stdin: bytes,
      maxOutputBytes: 1_024,
    });
    requireSuccess(result, "issue_37_sandbox_write_failed");
    const reportedBytes = result.stdout.trim();
    if (Number(reportedBytes) !== bytes.byteLength) {
      const safeReportedBytes = /^\d{1,12}$/.test(reportedBytes)
        ? reportedBytes
        : `non_numeric_${Buffer.from(reportedBytes, "utf8").toString("hex").slice(0, 20) || "empty"}`;
      const errorCode = `issue_37_sandbox_write_incomplete_${bytes.byteLength}_${safeReportedBytes}`;
      throw Object.assign(new Error(errorCode), { code: errorCode });
    }
  }

  async function copySource(sourcePath: string, destinationPath: string): Promise<void> {
    await write(destinationPath, await readFile(join(repositoryRoot, ...sourcePath.split("/")), "utf8"));
  }

  if (!(workspaceFiles instanceof Map)) throw new Error("issue_37_preview_assets_invalid");
  const readJson = (path: string): Record<string, unknown> => {
    const value = workspaceFiles.get(path);
    if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new Error("issue_37_preview_manifest_missing");
    const parsed = JSON.parse(typeof value === "string" ? value : Buffer.from(value).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("issue_37_preview_manifest_invalid");
    return parsed as Record<string, unknown>;
  };
  const publicBytes = (path: unknown, role: string): Uint8Array => {
    if (typeof path !== "string" || !/^assets\/generated\/[a-z0-9_/-]+\.(?:png|json)$/.test(path) || path.includes("..")) {
      throw Object.assign(new Error("issue_37_preview_asset_path_invalid"), { code: "issue_37_preview_asset_path_invalid" });
    }
    const value = workspaceFiles.get(`public/${path}`);
    if (typeof value === "string") return Buffer.from(value, "utf8");
    if (!(value instanceof Uint8Array)) throw Object.assign(new Error(`issue_37_${role}_missing`), { code: `issue_37_${role}_missing` });
    return value;
  };
  const atlasManifest = readJson("public/assets/generated/atlases/manifest.json");
  const animationIndex = readJson("public/assets/generated/animations/manifest.json");
  const tilesetManifest = readJson("public/assets/generated/tilesets/manifest.json");
  const tilemapManifest = readJson("public/assets/generated/tilemaps/manifest.json");
  const atlas = (atlasManifest.spritesheets as Array<Record<string, unknown>> | undefined)?.find((entry) => entry.name === "acceptance_hero");
  const animation = (animationIndex.animations as Array<Record<string, unknown>> | undefined)?.find((entry) => Array.isArray(entry.keys) && entry.keys.includes("acceptance-run"));
  const tileset = (tilesetManifest.tilesets as Array<Record<string, unknown>> | undefined)?.find((entry) => entry.name === "acceptance_terrain");
  const tilemap = (tilemapManifest.tilemaps as Array<Record<string, unknown>> | undefined)?.find((entry) => entry.name === "acceptance_level");
  if (!atlas || !animation || !tileset || !tilemap) throw new Error("issue_37_preview_manifest_entry_missing");
  const assetFiles = new Map([
    ["generated-spritesheet.png", publicBytes(atlas.imagePath, "atlas_texture")],
    ["generated-spritesheet.json", publicBytes(atlas.atlasPath, "atlas_json")],
    ["generated-animation.json", publicBytes(animation.path, "animation_json")],
    ["generated-tilemap.json", publicBytes(tilemap.path, "tilemap_json")],
    ["generated-map-tileset.png", publicBytes(tileset.imagePath, "tileset_texture")],
    ["generated-map-tileset.json", publicBytes(tileset.metadataPath, "tileset_metadata")],
  ]);

  try {
    await driver.create({ sandboxId, projectId, uid, image, limits, egressAllowlist: [] });
    process.stderr.write("ISSUE37_SANDBOX_CREATED\n");

    const packageJson = {
    name: "issue-37-phaser-preview",
    private: true,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: {
      test: "node tests/assets/preview/asset-fixture-contract.mjs",
      lint: "node --check tests/assets/preview/asset-fixture-contract.mjs",
      build: "node node_modules/vite/bin/vite.js build --config tests/assets/preview/vite.config.ts",
      dev: "node node_modules/vite/bin/vite.js --config tests/assets/preview/vite.config.ts",
    },
    dependencies: { vite: "7.3.7" },
  };
    await write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
    await write("tests/assets/preview/vite.config.ts", `import { fileURLToPath } from "node:url";\nimport { defineConfig } from "vite";\nexport default defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)), server: { host: "0.0.0.0", port: 4173, strictPort: true } });\n`);
    for (const relativePath of [
    "tests/assets/preview/index.html",
    "tests/assets/preview/main.ts",
    "tests/assets/preview/asset-fixture-contract.mjs",
    "packages/game-templates/phaser/src/game/tilesets.ts",
    "packages/game-templates/phaser/src/game/tilemaps.ts",
    "packages/game-templates/phaser/src/game/generated-assets.ts",
    "packages/game-templates/phaser/src/game/generated-animations.ts",
    ]) {
      await copySource(relativePath, relativePath);
    }

    await write("tests/assets/preview/public/fixtures/phaser.min.js", await readFile(join(repositoryRoot, "node_modules/phaser/dist/phaser.min.js")));
    for (const [filename, bytes] of assetFiles) await write(`tests/assets/preview/public/fixtures/${filename}`, bytes);

    const viteArchive = collectLockedViteRuntimeArchive();
    const archiveParts: string[] = [];
    for (let offset = 0, index = 0; offset < viteArchive.byteLength; offset += 6_000_000, index += 1) {
      const partPath = `issue37-vite-runtime-${index}.part`;
      archiveParts.push(partPath);
      await write(partPath, viteArchive.subarray(offset, Math.min(offset + 6_000_000, viteArchive.byteLength)));
    }
    const joinPartsSource = `const fs=require("node:fs");const parts=${JSON.stringify(archiveParts)};const output=fs.openSync("issue37-vite-runtime.tar.gz","w");for(const path of parts){fs.writeSync(output,fs.readFileSync(path));fs.unlinkSync(path)}fs.closeSync(output);`;
    const joinParts = await driver.exec(sandboxId, projectId, uid, ["node", "-e", joinPartsSource], "", 30_000, { maxOutputBytes: 1_024 });
    requireSuccess(joinParts, "issue_37_locked_vite_archive_join_failed");
    const unpack = await driver.exec(sandboxId, projectId, uid, ["tar", "-xzf", "issue37-vite-runtime.tar.gz", "-C", "."], "", 30_000, { maxOutputBytes: 1_024 });
    requireSuccess(unpack, "issue_37_locked_vite_unpack_failed");
    const removeArchive = await driver.exec(sandboxId, projectId, uid, ["/usr/local/bin/workspace-fs", "remove", "issue37-vite-runtime.tar.gz"], "", 30_000, { maxOutputBytes: 1_024 });
    requireSuccess(removeArchive, "issue_37_locked_vite_archive_cleanup_failed");
    for (const [script, code] of [["test", "issue_37_sandbox_test_failed"], ["lint", "issue_37_sandbox_lint_failed"], ["build", "issue_37_sandbox_build_failed"]] as const) {
      const check = await driver.exec(sandboxId, projectId, uid, ["npm", "run", script], "", limits.commandTimeoutMs, { maxOutputBytes: 12_000 });
      requireSuccess(check, code);
    }
    process.stderr.write("ISSUE37_SANDBOX_LOCKED_DEPENDENCIES_CHECKED\n");

    const server = await driver.exec(sandboxId, projectId, uid, ["node", "/opt/meta-game/server-manager.mjs", "start"], "", 15_000);
    requireSuccess(server, "issue_37_sandbox_preview_start_failed");
    let healthy = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const check = await driver.exec(sandboxId, projectId, uid, ["node", "/opt/meta-game/server-manager.mjs", "health"], "", 3_000).catch(() => undefined);
      if (check?.exitCode === 0) { healthy = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!healthy) throw new Error("issue_37_sandbox_preview_health_failed");
    process.stderr.write("ISSUE37_SANDBOX_PREVIEW_HEALTHY\n");

  const browserCheck = String.raw`
const assert = require("node:assert/strict");
const { chromium } = require("/opt/meta-game/node_modules/playwright");
let stage = "launch";
(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process"] });
  try {
    const context = await browser.newContext({ viewport: { width: 128, height: 96 }, serviceWorkers: "block" });
    let pageErrors = 0, phaserWarnings = 0, failedResponses = 0, externalRequests = 0;
    const pageErrorMessages = [];
    const page = await context.newPage();
    page.on("pageerror", (error) => { pageErrors += 1; pageErrorMessages.push(error.message); });
    page.on("console", (message) => {
      if (message.type() === "error") { pageErrors += 1; pageErrorMessages.push(message.text()); }
      if (message.type() === "warning" && /phaser/i.test(message.text())) phaserWarnings += 1;
    });
    page.on("requestfailed", () => { failedResponses += 1; });
    page.on("response", (response) => { if (response.status() >= 400) failedResponses += 1; });
    page.on("request", (request) => {
      const url = new URL(request.url());
      const local = ["http:", "ws:"].includes(url.protocol) && url.hostname === "127.0.0.1" && url.port === "4173";
      if (!["data:", "blob:"].includes(url.protocol) && !local) externalRequests += 1;
    });
    stage = "page_load";
    const response = await page.goto("http://127.0.0.1:4173/?mode=packed-spritesheet", { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200);
    await page.waitForFunction(() => window.__ASSET_PREVIEW_TEST__?.().loaded === true);
    stage = "tile_physics";
    await page.waitForFunction(() => {
      const state = window.__ASSET_PREVIEW_TEST__?.();
      return Boolean(state?.tilemap && state.playerBottom >= 63.5 && state.playerBottom <= 64.5 && state.tilemap.freePlayerBottom > 70);
    });
    await page.waitForFunction(() => (window.__ASSET_PREVIEW_TEST__?.().yoyoObservedFrames ?? []).length >= 3);
    stage = "atlas_animation";
    const initial = await page.evaluate(() => window.__ASSET_PREVIEW_TEST__?.());
    assert.deepEqual(initial.atlasFrames, ["idle_0", "run_0", "run_1", "run_2"]);
    assert.deepEqual(initial.animationRuntime.keys, ["acceptance-idle", "acceptance-run", "acceptance-yoyo"]);
    assert.deepEqual(initial.animationRuntime.frameOrder, ["run_0", "run_1", "run_2"]);
    assert.equal(initial.animationFps, 6);
    assert.ok(Math.abs(initial.animationRuntime.frameDurationMs - (1000 / 6)) < 0.01);
    assert.equal(initial.wallTileCollides, true);
    assert.equal(initial.emptyTileCollides, false);
    assert.equal(initial.tilemap.width, 16);
    assert.equal(initial.tilemap.layerNames.join(","), "background,hidden,ground,props");
    assert.deepEqual(initial.yoyoObservedFrames.slice(0, 3), ["run_0", "run_1", "run_0"]);
    assert.deepEqual(initial.yoyoRuntime, { frameOrder: ["run_0", "run_1"], frameRate: 8, repeat: 1, yoyo: true, delay: 50, repeatDelay: 25 });
    for (const pivot of Object.values(initial.pivots)) assert.deepEqual(pivot, { custom: true, x: 0.5, y: 1 });
    stage = "tile_render";
    const renderedTilePixels = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const context = canvas?.getContext("2d");
      if (!context) throw new Error("issue_37_canvas_context_missing");
      return [[8, 8], [24, 8], [40, 8], [56, 8]].map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3));
    });
    assert.deepEqual(renderedTilePixels, [[35, 115, 230], [38, 220, 80], [190, 70, 225], [230, 190, 35]]);
    stage = "keyboard_movement";
    const startX = initial.actorX;
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(1800);
    await page.keyboard.up("ArrowRight");
    await page.waitForFunction(() => {
      const frames = window.__ASSET_PREVIEW_TEST__?.().observedFrames.map(({ name }) => name) ?? [];
      return frames.some((name, index) => name === "run_0" && frames[index + 1] === "run_1" && frames[index + 2] === "run_2");
    });
    const moved = await page.evaluate(() => window.__ASSET_PREVIEW_TEST__?.());
    assert.ok(moved.actorX > startX + 20);
    assert.ok(moved.cameraScrollX > 0);
    const frameSamples = moved.observedFrames;
    const orderedRun = frameSamples.slice(0, -2).findIndex((sample, index) =>
      sample.name === "run_0" && frameSamples[index + 1]?.name === "run_1" && frameSamples[index + 2]?.name === "run_2");
    assert.ok(orderedRun >= 0);
    for (let index = orderedRun; index < orderedRun + 2; index += 1) {
      const interval = frameSamples[index + 1].at - frameSamples[index].at;
      assert.ok(interval >= 100 && interval <= 240);
    }
    stage = "wall_collision";
    const wallX = moved.actorX;
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(450);
    await page.keyboard.up("ArrowRight");
    const blocked = await page.evaluate(() => window.__ASSET_PREVIEW_TEST__?.());
    assert.ok(blocked.actorX > 72 && blocked.actorX < 96);
    assert.ok(Math.abs(blocked.actorX - wallX) < 3);
    const pageErrorHint = pageErrorMessages.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80);
    stage = "network_and_console_" + pageErrors + "_" + phaserWarnings + "_" + failedResponses + "_" + externalRequests + (pageErrorHint ? "_" + pageErrorHint : "");
    assert.equal(pageErrors, 0);
    assert.equal(phaserWarnings, 0);
    assert.equal(failedResponses, 0);
    assert.equal(externalRequests, 0);
    await context.close();
    process.stdout.write(JSON.stringify({ status: "passed", frameNames: initial.atlasFrames, animationFps: initial.animationFps, renderedTilePixels, actorX: blocked.actorX, cameraScrollX: blocked.cameraScrollX, collision: "solid wall blocked; empty cell passed", pageErrors, phaserWarnings, failedResponses, externalRequests }) + "\n");
  } finally { await browser.close(); }
})().catch((error) => { process.stderr.write("issue_37_browser_check_" + stage + ":" + String(error?.message ?? "failed").slice(0, 160) + "\n"); process.exitCode = 1; });
`;
    await write("tests/assets/preview/acceptance-browser.cjs", browserCheck);
    const browser = await driver.exec(sandboxId, projectId, uid, ["node", "tests/assets/preview/acceptance-browser.cjs"], "", 60_000, { maxOutputBytes: 12_000 });
    requireSuccess(browser, "issue_37_sandbox_browser_failed");
    const result = JSON.parse(browser.stdout.trim()) as Record<string, unknown>;
    if (result.status !== "passed") throw new Error("issue_37_sandbox_browser_failed");
    process.stdout.write(`Docker sandbox Phaser preview passed: ${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const errorCode = /^([a-z][a-z0-9_]{0,80})/.exec(message)?.[1] ?? "issue_37_sandbox_preview_unexpected_failure";
    process.stderr.write(`ISSUE37_SANDBOX_FAILURE=${errorCode}\n`);
    throw error;
} finally {
  await driver.destroy(sandboxId, projectId, uid);
  await driver.disposeSecurityRuntime();
}
}
