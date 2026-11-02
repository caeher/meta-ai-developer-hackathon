import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadDatabaseEnvironment, repositoryRoot } from "./db-environment.mjs";

try {
  loadDatabaseEnvironment();
  const drizzleCli = join(repositoryRoot, "node_modules", "drizzle-kit", "bin.cjs");
  const result = spawnSync(
    process.execPath,
    [drizzleCli, "migrate", "--config", "packages/db/drizzle.config.ts"],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw new Error("No se pudo iniciar Drizzle Kit.");
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "No se pudo ejecutar la migración.");
  process.exitCode = 1;
}
