import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillEntry, SkillsCatalog, SkillsManifest, SkillsVerificationResult } from "./types.js";

export const UPSTREAM_COMMIT = "19d93f97c9c1ea0f8b306e77aa81e0d3e352d3e9";
const CATALOG_PATH = "packages/skills/catalog.json";
const MANIFEST_PATH = "vendor/gamedev-skills/manifest.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function validateRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes("\\") || relativePath.includes(":") || relativePath.startsWith("/")) {
    return false;
  }
  const parts = relativePath.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function resolveRegularFile(rootDir: string, relativePath: string): Promise<string> {
  if (!validateRelativePath(relativePath)) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  const absolute = path.resolve(rootDir, ...relativePath.split("/"));
  const root = path.resolve(rootDir);
  const inside = path.relative(root, absolute);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`Path escapes package root: ${relativePath}`);
  }

  let current = root;
  for (const part of inside.split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relativePath}`);
  }
  const info = await lstat(absolute);
  if (!info.isFile()) throw new Error(`Expected a regular file: ${relativePath}`);
  return absolute;
}

async function readJsonFile(rootDir: string, relativePath: string): Promise<unknown> {
  const filePath = await resolveRegularFile(rootDir, relativePath);
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function getExpectedVendorPaths(catalogValue: unknown): string[] {
  const catalog = asRecord(catalogValue);
  if (!catalog) throw new Error("Catalog must be a JSON object.");
  const source = asRecord(catalog.source);
  const router = asRecord(catalog.router);
  const skills = Array.isArray(catalog.skills) ? catalog.skills : undefined;
  if (!source || !router || !skills) throw new Error("Catalog is missing source, router, or skills metadata.");

  const expected = new Set<string>();
  const add = (value: unknown, label: string) => {
    if (typeof value !== "string" || !validateRelativePath(value)) {
      throw new Error(`Catalog contains an invalid ${label} path.`);
    }
    expected.add(value);
  };
  add(source.licensePath, "license");
  add(source.noticePath, "notice");
  add(router.sourcePath, "router source");
  if (!Array.isArray(router.referencePaths)) throw new Error("Router referencePaths must be an array.");
  for (const referencePath of router.referencePaths) add(referencePath, "router reference");

  const ids = new Set<string>();
  for (const skillValue of skills) {
    const skill = asRecord(skillValue);
    if (!skill || typeof skill.id !== "string" || ids.has(skill.id)) {
      throw new Error("Catalog skill ids must be unique strings.");
    }
    ids.add(skill.id);
    if (typeof skill.sourcePath === "string") add(skill.sourcePath, `skill ${skill.id}`);
    else if (typeof skill.localPath !== "string" || !validateRelativePath(skill.localPath)) {
      throw new Error(`Skill ${skill.id} must have a safe sourcePath or localPath.`);
    }
    if (!Array.isArray(skill.references)) throw new Error(`Skill ${skill.id} references must be an array.`);
    const referenceIds = new Set<string>();
    for (const referenceValue of skill.references) {
      const reference = asRecord(referenceValue);
      if (!reference || typeof reference.id !== "string" || referenceIds.has(reference.id)) {
        throw new Error(`Skill ${skill.id} has an invalid or duplicate reference id.`);
      }
      referenceIds.add(reference.id);
      add(reference.sourcePath, `reference ${skill.id}.${reference.id}`);
    }
  }
  return [...expected].sort();
}

async function collectVendorFiles(rootDir: string): Promise<string[]> {
  const base = path.join(rootDir, "vendor", "gamedev-skills");
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Vendor tree contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile() && relative === "manifest.json") continue;
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Vendor tree contains a non-regular entry: ${relative}`);
    }
  }
  await visit(base, "");
  return files.sort();
}

export async function verifySkillsBundle(rootDir: string): Promise<SkillsVerificationResult> {
  const errors: string[] = [];
  let fileCount = 0;
  let catalogValue: unknown;
  let manifestValue: unknown;
  try {
    catalogValue = await readJsonFile(rootDir, CATALOG_PATH);
  } catch (error) {
    return { valid: false, errors: [`Cannot read skills catalog: ${error instanceof Error ? error.message : "unknown error"}`], fileCount };
  }
  try {
    manifestValue = await readJsonFile(rootDir, MANIFEST_PATH);
  } catch (error) {
    return { valid: false, errors: [`Cannot read vendor manifest: ${error instanceof Error ? error.message : "unknown error"}`], fileCount };
  }

  const catalog = asRecord(catalogValue);
  const source = asRecord(catalog?.source);
  const manifest = asRecord(manifestValue);
  if (!catalog || !source || !manifest) {
    return { valid: false, errors: ["Catalog source or vendor manifest is not a JSON object."], fileCount };
  }

  if (source.commit !== UPSTREAM_COMMIT || !COMMIT_PATTERN.test(String(source.commit))) {
    errors.push(`Catalog source commit must be the pinned SHA ${UPSTREAM_COMMIT}.`);
  }
  if (manifest.sourceCommit !== UPSTREAM_COMMIT || !COMMIT_PATTERN.test(String(manifest.sourceCommit))) {
    errors.push(`Vendor sourceCommit must be the pinned SHA ${UPSTREAM_COMMIT}.`);
  }
  if (manifest.repository !== source.repository || manifest.license !== source.license) {
    errors.push("Vendor manifest repository or license metadata does not match the catalog.");
  }

  let expectedPaths: string[] = [];
  try {
    expectedPaths = getExpectedVendorPaths(catalogValue);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Invalid catalog paths.");
  }
  if (!Array.isArray(manifest.files)) {
    errors.push("Vendor manifest files must be an array.");
    return { valid: false, errors, fileCount };
  }

  const manifestFiles = new Map<string, string>();
  for (const entryValue of manifest.files) {
    const entry = asRecord(entryValue);
    if (!entry || typeof entry.path !== "string" || !validateRelativePath(entry.path) || typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      errors.push("Vendor manifest has an invalid file path or SHA-256 value.");
      continue;
    }
    if (manifestFiles.has(entry.path)) {
      errors.push(`Vendor manifest contains a duplicate path: ${entry.path}`);
      continue;
    }
    manifestFiles.set(entry.path, entry.sha256);
  }

  for (const expectedPath of expectedPaths) {
    if (!manifestFiles.has(expectedPath)) errors.push(`Missing manifest reference for ${expectedPath}.`);
  }
  for (const manifestPath of manifestFiles.keys()) {
    if (!expectedPaths.includes(manifestPath)) errors.push(`Manifest contains an unreferenced vendor file: ${manifestPath}.`);
  }

  for (const [relativePath, expectedHash] of manifestFiles) {
    try {
      const pathFromRoot = `vendor/gamedev-skills/${relativePath}`;
      const absolute = await resolveRegularFile(rootDir, pathFromRoot);
      const actualHash = createHash("sha256").update(await readFile(absolute)).digest("hex");
      if (actualHash !== expectedHash) errors.push(`SHA-256 mismatch for ${pathFromRoot}.`);
      fileCount += 1;
    } catch {
      errors.push(`Missing or unsafe vendor file: vendor/gamedev-skills/${relativePath}.`);
    }
  }

  try {
    const actualPaths = await collectVendorFiles(rootDir);
    const expected = [...manifestFiles.keys()].sort();
    if (actualPaths.join("\n") !== expected.join("\n")) {
      errors.push("Vendor tree has missing or untracked files compared with the manifest.");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Cannot inspect vendor tree.");
  }

  const skills = Array.isArray(catalog.skills) ? catalog.skills as SkillEntry[] : [];
  for (const skill of skills) {
    for (const localPath of [skill.localPath, skill.adapterForPhaser3].filter((entry): entry is string => Boolean(entry))) {
      try {
        await resolveRegularFile(rootDir, localPath);
      } catch {
        errors.push(`Missing or unsafe local guide for ${skill.id}: ${localPath}.`);
      }
    }
  }

  return { valid: errors.length === 0, errors, fileCount };
}

export async function writeSkillsManifest(rootDir: string): Promise<number> {
  const catalog = await readJsonFile(rootDir, CATALOG_PATH) as SkillsCatalog;
  if (catalog.source.commit !== UPSTREAM_COMMIT || !COMMIT_PATTERN.test(catalog.source.commit)) {
    throw new Error(`Refusing to write a manifest for an unpinned source; expected ${UPSTREAM_COMMIT}.`);
  }
  const paths = getExpectedVendorPaths(catalog);
  const files = [];
  for (const relativePath of paths) {
    const absolute = await resolveRegularFile(rootDir, `vendor/gamedev-skills/${relativePath}`);
    const sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
    files.push({ path: relativePath, sha256 });
  }
  const manifest: SkillsManifest = {
    schemaVersion: 1,
    repository: catalog.source.repository,
    sourceCommit: UPSTREAM_COMMIT,
    license: catalog.source.license,
    files,
  };
  const output = path.resolve(rootDir, MANIFEST_PATH);
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return files.length;
}

export async function loadCatalogMetadata(rootDir: string): Promise<SkillsCatalog> {
  const value = await readJsonFile(rootDir, CATALOG_PATH);
  const catalog = asRecord(value);
  const source = asRecord(catalog?.source);
  const router = asRecord(catalog?.router);
  if (!catalog || !source || !router || !Array.isArray(catalog.skills) || catalog.schemaVersion !== 1) {
    throw new Error("Invalid skills catalog metadata.");
  }
  if (source.commit !== UPSTREAM_COMMIT || !COMMIT_PATTERN.test(String(source.commit))) {
    throw new Error(`Catalog commit is not the pinned SHA ${UPSTREAM_COMMIT}.`);
  }
  if (typeof catalog.tokenBudget !== "number" || catalog.tokenBudget !== 8000) {
    throw new Error("Skills catalog must set the versioned token budget to 8000.");
  }
  return catalog as unknown as SkillsCatalog;
}

export async function loadManifestMetadata(rootDir: string, catalog: SkillsCatalog): Promise<SkillsManifest> {
  const value = await readJsonFile(rootDir, MANIFEST_PATH);
  const manifest = asRecord(value);
  if (!manifest || manifest.schemaVersion !== 1 || manifest.sourceCommit !== UPSTREAM_COMMIT || !Array.isArray(manifest.files)) {
    throw new Error("Invalid skills vendor manifest metadata.");
  }
  if (manifest.repository !== catalog.source.repository || manifest.license !== catalog.source.license) {
    throw new Error("Skills vendor manifest metadata does not match the catalog.");
  }
  return manifest as unknown as SkillsManifest;
}
