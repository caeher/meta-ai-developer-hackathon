import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const files = await listFiles(dist);
const htmlPath = join(dist, "index.html");
const html = await readFile(htmlPath, "utf8");
const assets = files.filter((path) => /\.(?:js|css|svg|json)$/.test(path));
const fileCache = new Map(await Promise.all(assets.map(async (path) => [path, await readFile(path, "utf8")])));

if (!html.includes("./assets/") || /(?:src|href)=["']https?:\/\//i.test(html)) {
  throw new Error("template_build_requires_remote_asset");
}
if (files.some((path) => path.endsWith(".map")) || assets.some((path) => /sourceMappingURL=/.test(readFileSync(path)))) {
  throw new Error("template_build_source_maps_enabled");
}
if (assets.some((path) => readFileSync(path).includes("__GAME_TEST__"))) {
  throw new Error("template_build_contains_development_hook");
}
if (!files.some((path) => relative(dist, path).replaceAll("\\", "/") === "assets/manifest.json")) {
  throw new Error("template_build_manifest_missing");
}

process.stdout.write("Static game build is self-contained; development hooks and source maps are absent.\n");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : (await stat(path)).isFile() ? [path] : [];
  }));
  return nested.flat();
}

function readFileSync(path) {
  return fileCache.get(path) ?? "";
}
