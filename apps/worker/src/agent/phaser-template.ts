import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxInstallDependenciesInputSchema } from "@meta-game/contracts";
import type { AgentSandbox } from "./tools";

export const PHASER_TEMPLATE_ID = "phaser-3.90.0-v1";
export const PHASER_TEMPLATE_MARKER_PATH = ".meta-game-template.json";

const PHASER_TEMPLATE_ROOT = fileURLToPath(new URL("../../../../packages/game-templates/phaser/", import.meta.url));
const TEMPLATE_FILES = [
  ".nvmrc",
  ".npmrc",
  "index.html",
  "package.json",
  "package-lock.json",
  "public/assets/bullet.svg",
  "public/assets/crystal.svg",
  "public/assets/enemy.svg",
  "public/assets/generated/manifest.json",
  "public/assets/gate.svg",
  "public/assets/manifest.json",
  "public/assets/player.svg",
  "public/assets/tile.svg",
  "scripts/check-build.mjs",
  "src/game/BootScene.ts",
  "src/game/HudScene.ts",
  "src/game/PlayScene.ts",
  "src/game/assets.test.ts",
  "src/game/generated-assets.test.ts",
  "src/game/generated-assets.ts",
  "src/game/audio.ts",
  "src/game/logic.test.ts",
  "src/game/logic.ts",
  "src/game/types.ts",
  "src/main.ts",
  "src/style.css",
  "tsconfig.json",
  "vite.config.ts",
] as const;

const MAX_TEMPLATE_FILES = 32;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const TEMPLATE_SOURCE_ROOT = resolve(PHASER_TEMPLATE_ROOT);

export type PhaserTemplateFile = Readonly<{ path: string; content: string; sha256: string }>;
export type PhaserTemplateBundle = Readonly<{
  id: string;
  manifestSha256: string;
  files: readonly PhaserTemplateFile[];
  dependencies: readonly Readonly<{ name: string; version: string }>[];
}>;

export type PhaserTemplateInspection =
  | Readonly<{ status: "ready"; manifestSha256: string }>
  | Readonly<{ status: "resume" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "preserve" }>;

export type TemplateCheck = Readonly<{
  check: string;
  status: "passed" | "failed";
  exitCode?: number;
  summary: string;
}>;

export async function loadPhaserTemplate(): Promise<PhaserTemplateBundle> {
  if (TEMPLATE_FILES.length > MAX_TEMPLATE_FILES) throw new Error("phaser_template_file_limit");
  const files: PhaserTemplateFile[] = [];
  let totalBytes = 0;

  for (const path of TEMPLATE_FILES) {
    const sourcePath = resolve(TEMPLATE_SOURCE_ROOT, ...path.split("/"));
    const fromRoot = relative(TEMPLATE_SOURCE_ROOT, sourcePath);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) throw new Error("phaser_template_source_invalid");
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("phaser_template_source_invalid");
    const content = await readFile(sourcePath, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > 1_048_576) throw new Error("phaser_template_file_too_large");
    totalBytes += bytes;
    if (totalBytes > MAX_TEMPLATE_BYTES) throw new Error("phaser_template_bundle_too_large");
    files.push({ path, content, sha256: sha256(content) });
  }

  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const packageJson = parsePackageJson(byPath.get("package.json"));
  validatePackage(packageJson, byPath.get(".nvmrc"), byPath.get(".npmrc"));
  const lock = parsePackageJson(byPath.get("package-lock.json"));
  const lockPackages = asRecord(lock.packages);
  const rootLock = asRecord(lockPackages?.[""]);
  const rootDependencies = asRecord(rootLock?.dependencies);
  const rootDevDependencies = asRecord(rootLock?.devDependencies);
  const packageDependencies = asRecord(packageJson.dependencies);
  const packageDevDependencies = asRecord(packageJson.devDependencies);
  if (lock.lockfileVersion !== 3 || !packageDependencies || !packageDevDependencies ||
    !sameStringRecord(rootDependencies, packageDependencies) || !sameStringRecord(rootDevDependencies, packageDevDependencies) ||
    packageDependencies.phaser !== "3.90.0") {
    throw new Error("phaser_template_lockfile_invalid");
  }

  const dependencies = Object.entries({ ...asRecord(packageJson.dependencies), ...asRecord(packageJson.devDependencies) })
    .map(([name, version]) => ({ name, version: String(version) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const parsedDependencies = SandboxInstallDependenciesInputSchema.safeParse({ packages: dependencies });
  if (!parsedDependencies.success) throw new Error("phaser_template_dependencies_invalid");

  const manifest = files.map(({ path, sha256, content }) => ({ path, sha256, bytes: Buffer.byteLength(content, "utf8") }));
  return {
    id: PHASER_TEMPLATE_ID,
    manifestSha256: sha256(JSON.stringify(manifest)),
    files,
    dependencies: parsedDependencies.data.packages,
  };
}

export async function inspectPhaserTemplate(
  sandbox: AgentSandbox,
  projectId: string,
  template: PhaserTemplateBundle,
  signal: AbortSignal,
  resumeCurrentRun: boolean,
): Promise<PhaserTemplateInspection> {
  try {
    const markerFile = await sandbox.readFile(projectId, PHASER_TEMPLATE_MARKER_PATH, signal);
    const marker = parseMarker(markerFile.content);
    if (!marker) return resumeCurrentRun ? { status: "resume" } : { status: "preserve" };
    if (marker.templateId !== template.id || marker.manifestSha256 !== template.manifestSha256) {
      return resumeCurrentRun ? { status: "resume" } : { status: "preserve" };
    }
    if (marker.status === "ready") return { status: "ready", manifestSha256: template.manifestSha256 };
    if (marker.status === "installing") return { status: "resume" };
    return { status: "preserve" };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (resumeCurrentRun) return { status: "resume" };
  try {
    const root = await sandbox.listFiles(projectId, "", signal);
    return root.files.length === 0 ? { status: "empty" } : { status: "preserve" };
  } catch (error) {
    if (errorCode(error) === "directory_read_failed") return { status: "preserve" };
    throw error;
  }
}

export async function materializePhaserTemplate(
  sandbox: AgentSandbox,
  projectId: string,
  template: PhaserTemplateBundle,
  signal: AbortSignal,
  onCheck: (check: TemplateCheck) => Promise<void>,
): Promise<void> {
  await writeMarker(sandbox, projectId, template, "installing", signal);
  for (const file of template.files) {
    const result = await sandbox.writeFile(projectId, file.path, file.content, signal);
    if (result.bytesWritten !== Buffer.byteLength(file.content, "utf8")) throw new Error("phaser_template_write_incomplete");
  }

  const install = await sandbox.installDependencies(projectId, { packages: [...template.dependencies] }, signal);
  await recordCheck(onCheck, "Phaser dependencies", install.exitCode,
    "Dependencias exactas instaladas sin lifecycle scripts.", "No se pudieron instalar las dependencias Phaser.");

  const tests = await sandbox.runCommand(projectId, { command: "npm", args: ["test"], cwd: "" }, signal);
  await recordCheck(onCheck, "Phaser template npm test", tests.exitCode,
    "Las pruebas unitarias de la plantilla pasaron.", "Fallaron las pruebas unitarias de la plantilla.");

  const build = await sandbox.runCommand(projectId, { command: "npm", args: ["run", "build"], cwd: "" }, signal);
  await recordCheck(onCheck, "Phaser template npm run build", build.exitCode,
    "La build estática de la plantilla pasó.", "Falló la build estática de la plantilla.");

  const server = await sandbox.startDevServer(projectId, signal);
  if (server.status !== "ready" || server.port !== 4173) {
    await onCheck({ check: "Phaser template preview", status: "failed", summary: "El servidor fijo no pasó su health check." });
    throw new Error("phaser_template_preview_unhealthy");
  }
  await onCheck({ check: "Phaser template preview", status: "passed", summary: "Vite está listo en el puerto privado 4173." });
  await writeMarker(sandbox, projectId, template, "ready", signal);
}

export async function startPhaserTemplatePreview(sandbox: AgentSandbox, projectId: string, signal: AbortSignal): Promise<void> {
  const server = await sandbox.startDevServer(projectId, signal);
  if (server.status !== "ready" || server.port !== 4173) throw new Error("phaser_template_preview_unhealthy");
}

function validatePackage(packageJson: Record<string, unknown>, nodeVersion: string | undefined, npmrc: string | undefined): void {
  if (nodeVersion?.trim() !== "24" || npmrc?.trim() !== "engine-strict=true") throw new Error("phaser_template_runtime_config_invalid");
  if (asRecord(packageJson.engines)?.node !== ">=24 <25") throw new Error("phaser_template_node_version_invalid");
  if (asRecord(packageJson.dependencies)?.phaser !== "3.90.0") throw new Error("phaser_template_phaser_version_invalid");
  const scripts = asRecord(packageJson.scripts);
  if (!scripts) throw new Error("phaser_template_scripts_invalid");
  if (typeof scripts.dev !== "string" || typeof scripts.test !== "string" || typeof scripts.build !== "string" ||
    Object.keys(scripts).some((name) => !["dev", "test", "build", "preview"].includes(name))) {
    throw new Error("phaser_template_scripts_invalid");
  }
}

function parsePackageJson(text: string | undefined): Record<string, unknown> {
  if (!text) throw new Error("phaser_template_manifest_missing");
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Return the stable template error below. */ }
  throw new Error("phaser_template_manifest_invalid");
}

function parseMarker(text: string): { templateId: string; manifestSha256: string; status: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const marker = parsed as Record<string, unknown>;
    if (marker.schemaVersion !== 1 || typeof marker.templateId !== "string" ||
      typeof marker.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.manifestSha256) ||
      typeof marker.status !== "string") return undefined;
    return { templateId: marker.templateId, manifestSha256: marker.manifestSha256, status: marker.status };
  } catch { return undefined; }
}

async function writeMarker(
  sandbox: AgentSandbox,
  projectId: string,
  template: PhaserTemplateBundle,
  status: "installing" | "ready",
  signal: AbortSignal,
): Promise<void> {
  const content = JSON.stringify({ schemaVersion: 1, templateId: template.id, manifestSha256: template.manifestSha256, status });
  const result = await sandbox.writeFile(projectId, PHASER_TEMPLATE_MARKER_PATH, content, signal);
  if (result.bytesWritten !== Buffer.byteLength(content, "utf8")) throw new Error("phaser_template_marker_write_failed");
}

async function recordCheck(
  callback: (check: TemplateCheck) => Promise<void>,
  check: string,
  exitCode: number,
  passedSummary: string,
  failedSummary: string,
): Promise<void> {
  const passed = exitCode === 0;
  await callback({ check, status: passed ? "passed" : "failed", exitCode, summary: passed ? passedSummary : failedSummary });
  if (!passed) throw new Error("phaser_template_check_failed");
}

function isNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return code === "not_found" || code === "sandbox_not_found" || code === "sandbox_file_not_found" || code === "sandbox_path_not_found";
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sameStringRecord(left: Record<string, unknown> | undefined, right: Record<string, unknown>): boolean {
  if (!left || Object.keys(left).length !== Object.keys(right).length) return false;
  return Object.entries(right).every(([key, value]) => typeof value === "string" && left[key] === value);
}
