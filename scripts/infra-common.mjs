import { chmodSync, copyFileSync, existsSync, readFileSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseInfraEnvironment } from "../packages/config/src/infra-environment.ts";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = dirname(scriptsDirectory);
export const infraDirectory = join(repositoryRoot, "infra");
export const composeFile = join(infraDirectory, "compose.yml");
export const localEnvironmentFile = join(infraDirectory, ".env");
const exampleEnvironmentFile = join(infraDirectory, "env.example");

export function ensureLocalEnvironmentFile() {
  if (!existsSync(localEnvironmentFile)) {
    try {
      copyFileSync(exampleEnvironmentFile, localEnvironmentFile, constants.COPYFILE_EXCL);
      if (process.platform !== "win32") chmodSync(localEnvironmentFile, 0o600);
      console.log("Creado infra/.env con valores locales; el archivo está excluido de Git.");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new Error("No se pudo preparar infra/.env desde infra/env.example.");
      }
    }
  }

  return localEnvironmentFile;
}

function parseEnvFile(contents) {
  const values = {};

  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(`Formato inválido en infra/.env, línea ${index + 1}.`);
    }

    const [, key, rawValue] = match;
    if (Object.hasOwn(values, key)) {
      throw new Error(`Variable duplicada en infra/.env: ${key}.`);
    }

    const value = rawValue.trim();
    const quoted = /^(?:"(.*)"|'(.*)')$/.exec(value);
    values[key] = quoted ? (quoted[1] ?? quoted[2] ?? "") : value;
  }

  return values;
}

export function readLocalEnvironment() {
  const contents = readFileSync(localEnvironmentFile, "utf8");
  const values = parseEnvFile(contents);
  return parseInfraEnvironment(values);
}

export function composeArguments(extra = []) {
  return ["compose", "--file", composeFile, "--env-file", localEnvironmentFile, ...extra];
}

export function runDocker(arguments_, { quiet = false } = {}) {
  const result = spawnSync(process.platform === "win32" ? "docker.exe" : "docker", arguments_, {
    cwd: repositoryRoot,
    stdio: quiet ? "ignore" : "inherit",
    windowsHide: true,
    shell: false,
  });

  if (result.error) {
    throw new Error("No se pudo ejecutar Docker. Comprueba que Docker Engine y Compose estén instalados y activos.");
  }

  if (result.status !== 0) {
    throw new Error(quiet ? "Falló una operación de infraestructura local." : "Docker Compose terminó con error.");
  }
}

export function reportInfrastructureError(error) {
  const message = error instanceof Error ? error.message : "Error de configuración de infraestructura.";
  console.error(message);
  process.exitCode = 1;
}
