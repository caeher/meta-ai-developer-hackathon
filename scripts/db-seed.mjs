import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadDatabaseEnvironment, repositoryRoot } from "./db-environment.mjs";

try {
  loadDatabaseEnvironment();
  const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const result = spawnSync(process.execPath, [tsxCli, "scripts/seed.ts"], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw new Error("No se pudo iniciar el seed sintético.");
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "No se pudo ejecutar el seed.");
  process.exitCode = 1;
}
