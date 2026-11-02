import {
  composeArguments,
  ensureLocalEnvironmentFile,
  readLocalEnvironment,
  reportInfrastructureError,
  runDocker,
} from "./infra-common.mjs";
import { spawnSync } from "node:child_process";

function parseOptions(arguments_) {
  const options = { web: false, worker: false, preview: false, publishing: false };

  for (const argument of arguments_) {
    if (argument === "--web") options.web = true;
    else if (argument === "--worker") options.worker = true;
    else if (argument === "--preview") options.preview = true;
    else if (argument === "--publishing") options.publishing = true;
    else throw new Error(`Opción desconocida para infra:up: ${argument}`);
  }

  return options;
}

function ensureSandboxEgressNetwork() {
  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const inspect = spawnSync(docker, ["network", "inspect", "mg-sandbox-egress"], { stdio: "ignore", windowsHide: true, shell: false });
  if (!inspect.error && inspect.status === 0) return;
  const create = spawnSync(docker, [
    "network", "create", "--driver", "bridge",
    "--label", "com.meta-game.managed=true",
    "--label", "com.meta-game.network-kind=egress",
    "mg-sandbox-egress",
  ], { stdio: "ignore", windowsHide: true, shell: false });
  if (create.error || create.status !== 0) {
    const retry = spawnSync(docker, ["network", "inspect", "mg-sandbox-egress"], { stdio: "ignore", windowsHide: true, shell: false });
    if (retry.error || retry.status !== 0) throw new Error("No se pudo preparar la red privada de preview.");
  }
}

function initializeStorageBuckets(environment) {
  const configDirectory = "/tmp/forja-mcli-config";
  const common = ["exec", "-T", "s3", "mcli", "--config-dir", configDirectory];
  const alias = [
    ...common,
    "alias",
    "set",
    "local",
    "http://127.0.0.1:9000",
    environment.MINIO_ROOT_USER,
    environment.MINIO_ROOT_PASSWORD,
  ];
  runDocker(composeArguments(alias), { quiet: true });

  for (const bucket of [environment.S3_BUCKET_PRIVATE, environment.S3_BUCKET_PUBLIC]) {
    runDocker(
      composeArguments([
        ...common,
        "mb",
        "--ignore-existing",
        `local/${bucket}`,
      ]),
      { quiet: true },
    );
    runDocker(
      composeArguments([
        ...common,
        "anonymous",
        "set",
        "none",
        `local/${bucket}`,
      ]),
      { quiet: true },
    );
  }
}

try {
  const options = parseOptions(process.argv.slice(2));
  ensureLocalEnvironmentFile();
  const environment = readLocalEnvironment();
  if (options.preview) {
    if (environment.PREVIEW_GATEWAY_ENABLED !== "true") {
      throw new Error("Configura PREVIEW_GATEWAY_ENABLED=true y claves RSA en infra/.env antes de iniciar el gateway.");
    }
    if ([environment.PREVIEW_TOKEN_KEY_ID, environment.PREVIEW_TOKEN_PRIVATE_KEY, environment.PREVIEW_TOKEN_PUBLIC_KEYS]
      .some((value) => value.toLowerCase().includes("replace-with"))) {
      throw new Error("Configura las claves RSA activas y públicas en infra/.env; no se inició el gateway.");
    }
    ensureSandboxEgressNetwork();
  }
  if (options.publishing) {
    if (environment.PUBLISHING_ENABLED !== "true") throw new Error("Configura PUBLISHING_ENABLED=true antes de iniciar el origen público.");
    if (environment.SANDBOX_DRIVER !== "rootless") throw new Error("Publicar requiere SANDBOX_DRIVER=rootless en el host Linux dedicado.");
  }
  const profiles = [
    ...(options.web || options.publishing ? ["--profile", "web"] : []),
    ...(options.worker || options.publishing ? ["--profile", "worker"] : []),
    ...(options.publishing ? ["--profile", "publishing"] : []),
    ...(options.preview ? ["--profile", "preview"] : []),
  ];
  runDocker(composeArguments([...profiles, "up", "--detach", "--wait"]));
  initializeStorageBuckets(environment);
  console.log("Postgres, Redis y S3 local están disponibles; los buckets siguen siendo privados.");
  if (options.web) console.log("La aplicación web está disponible en http://localhost:3000.");
  if (options.worker) console.log("El worker está activo; los runs terminan con orchestrator_pending hasta integrar el orquestador.");
  if (options.publishing) console.log("El worker y el origen de publicación están activos; configura DNS/TLS wildcard y un bucket privado de lectura para el origen.");
} catch (error) {
  reportInfrastructureError(error);
}
