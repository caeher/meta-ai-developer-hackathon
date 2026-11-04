import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  composeArguments,
  ensureLocalEnvironmentFile,
  localEnvironmentFile,
  readExampleEnvironment,
  readLocalEnvironment,
  repositoryRoot,
  reportInfrastructureError,
  runDocker,
} from "./infra-common.mjs";
import { spawnSync } from "node:child_process";

function parseOptions(arguments_) {
  const options = { web: false, worker: false, preview: false, publishing: false, localDomains: false, acceptance: false, runs: false, simulator: false };

  for (const argument of arguments_) {
    if (argument === "--web") options.web = true;
    else if (argument === "--worker") options.worker = true;
    else if (argument === "--preview") options.preview = true;
    else if (argument === "--publishing") options.publishing = true;
    else if (argument === "--local-domains") options.localDomains = true;
    else if (argument === "--acceptance") options.acceptance = true;
    else if (argument === "--runs") options.runs = true;
    else if (argument === "--simulator") options.simulator = true;
    else throw new Error(`Opción desconocida para infra:up: ${argument}`);
  }

  if (options.runs && !options.acceptance) throw new Error("--runs solo se permite junto a --acceptance.");
  if (options.simulator && (!options.acceptance || !options.runs)) throw new Error("--simulator solo se permite junto a --acceptance --runs.");
  return options;
}

function ensureSandboxEgressNetwork() {
  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const inspect = spawnSync(docker, ["network", "inspect", "mg-sandbox-egress"], { stdio: "ignore", windowsHide: true, shell: false, env: safeProcessEnvironment() });
  if (!inspect.error && inspect.status === 0) return;
  const create = spawnSync(docker, [
    "network", "create", "--driver", "bridge",
    "--label", "com.meta-game.managed=true",
    "--label", "com.meta-game.network-kind=egress",
    "mg-sandbox-egress",
  ], { stdio: "ignore", windowsHide: true, shell: false, env: safeProcessEnvironment() });
  if (create.error || create.status !== 0) {
    const retry = spawnSync(docker, ["network", "inspect", "mg-sandbox-egress"], { stdio: "ignore", windowsHide: true, shell: false, env: safeProcessEnvironment() });
    if (retry.error || retry.status !== 0) throw new Error("No se pudo preparar la red privada de preview.");
  }
}

function safeProcessEnvironment(overrides = {}) {
  const allowed = new Set([
    "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "COMSPEC", "PROGRAMFILES",
    "PROGRAMFILES(X86)", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONFIG",
  ]);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  return { ...environment, ...overrides };
}

function buildAcceptanceSandboxImage() {
  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const build = spawnSync(docker, [
    "build", "--file", "infra/sandbox/Dockerfile", "--tag", "meta-game-sandbox:acceptance", ".",
  ], { cwd: repositoryRoot, stdio: "inherit", windowsHide: true, shell: false, env: safeProcessEnvironment() });
  if (build.error || build.status !== 0) throw new Error("No se pudo construir la imagen sandbox local.");

  const inspect = spawnSync(docker, ["image", "inspect", "--format", "{{.Id}}", "meta-game-sandbox:acceptance"], {
    cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false,
    env: safeProcessEnvironment(),
  });
  const imageId = inspect.stdout?.trim();
  if (inspect.error || inspect.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId ?? "")) {
    throw new Error("La imagen sandbox no devolviÃ³ un identificador de contenido vÃ¡lido.");
  }
  return imageId;
}

function createAcceptanceEnvironment(sandboxImage, runsEnabled, simulatorEnabled) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = `local-acceptance-${randomUUID()}`;
  const privateKeyBase64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const localToken = () => randomBytes(48).toString("base64url");

  return {
    APP_ORIGIN: "http://127.0.0.1:3000",
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    AUTH_ALLOWED_ORIGINS: "http://127.0.0.1:3000,http://localhost:3000,https://app.localhost",
    AUTH_SECRET: randomBytes(32).toString("base64url"),
    PREVIEW_GATEWAY_ENABLED: "true",
    PREVIEW_BASE_DOMAIN: "preview.localhost",
    PREVIEW_TOKEN_KEY_ID: keyId,
    PREVIEW_TOKEN_PRIVATE_KEY: privateKeyBase64,
    PREVIEW_TOKEN_PUBLIC_KEYS: JSON.stringify({ [keyId]: publicKeyBase64 }),
    PREVIEW_TOKEN_TTL_SECONDS: "60",
    PREVIEW_SESSION_TTL_SECONDS: "900",
    PUBLISHING_ENABLED: "true",
    PUBLISH_BASE_DOMAIN: "games.localhost",
    RUNS_ENABLED: runsEnabled ? "true" : "false",
    RUNS_SIMULATOR_ENABLED: simulatorEnabled ? "true" : "false",
    AGENT_ASSET_TOOL_CALLS_ENABLED: "false",
    RESOURCE_LIFECYCLE_ENABLED: "false",
    SANDBOX_DRIVER: "rootless",
    SANDBOX_HOST_RUNTIME_MODE: "docker-desktop-security",
    SANDBOX_WORKSPACE_MODE: "tmpfs",
    SANDBOX_IMAGE: sandboxImage,
    SANDBOX_DOCKER_SOCKET: "/var/run/docker.sock",
    SANDBOX_CONTROLLER_URL: "http://sandbox-controller:8081",
    SANDBOX_CONTROLLER_TOKEN: localToken(),
    SANDBOX_CONTROLLER_HOST: "0.0.0.0",
    WORKER_INTERNAL_TOKEN: localToken(),
  };
}

function migrateAcceptanceDatabase(envFile, dockerEnvironment) {
  runDocker(composeArguments([
    "exec", "-T", "web", "node_modules/.bin/drizzle-kit", "migrate", "--config", "packages/db/drizzle.config.ts",
  ], envFile), { env: dockerEnvironment });
}

function localHttpsStatus(hostname, pathname) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port: 443,
      servername: hostname,
      path: pathname,
      method: "GET",
      headers: { host: hostname },
      rejectUnauthorized: false,
      timeout: 5_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("timeout", () => request.destroy(new Error("local_https_timeout")));
    request.once("error", reject);
    request.end();
  });
}

function localHttpStatus(hostname, pathname) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: 80,
      path: pathname,
      method: "GET",
      headers: { host: hostname },
      timeout: 5_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("timeout", () => request.destroy(new Error("local_http_timeout")));
    request.once("error", reject);
    request.end();
  });
}

async function verifyLocalHttpsRoutes() {
  const routes = [
    ["app.localhost", "/api/health/readyz", (status) => status === 200],
    [`probe-${randomUUID()}.preview.localhost`, "/", (status) => status === 404],
    [`probe-${randomUUID()}.games.localhost`, "/", (status) => status === 404],
  ];
  for (const [hostname, pathname, isExpectedStatus] of routes) {
    let status = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        status = await localHttpsStatus(hostname, pathname);
        if (isExpectedStatus(status)) break;
      } catch { /* Retry while Caddy issues its local certificate. */ }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!isExpectedStatus(status)) throw new Error(`No se pudo validar la ruta HTTPS local ${hostname} (HTTP ${status}).`);
  }
}

async function verifyLocalHttpPreviewRoute() {
  const hostname = `${randomUUID()}.preview.localhost`;
  let status = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      status = await localHttpStatus(hostname, "/");
      if (status === 404) break;
    } catch { /* Retry while the HTTP-only acceptance router starts. */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (status !== 404) throw new Error(`No se pudo validar la ruta HTTP local de preview (HTTP ${status}).`);
}

function initializeStorageBuckets(envFile, dockerEnvironment) {
  const configDirectory = "/tmp/forja-mcli-config";
  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const bucketsResult = spawnSync(docker, composeArguments([
    "exec", "-T", "worker", "node", "-e",
    "process.stdout.write(JSON.stringify([process.env.S3_BUCKET_PRIVATE,process.env.S3_BUCKET_PUBLIC]))",
  ], envFile), {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    shell: false,
    env: dockerEnvironment,
  });
  if (bucketsResult.error || bucketsResult.status !== 0) {
    throw new Error("No se pudieron resolver los buckets configurados para Silo.");
  }

  let buckets;
  try { buckets = JSON.parse(bucketsResult.stdout); }
  catch { throw new Error("La configuración de buckets de Silo no devolvió una lista válida."); }
  if (!Array.isArray(buckets) || buckets.length !== 2 || buckets.some((bucket) =>
    typeof bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))) {
    throw new Error("Los nombres de bucket configurados para Silo no son válidos.");
  }

  const initialize = [
    "set -eu",
    `mcli --config-dir ${configDirectory} alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"`,
    "for bucket do",
    `  mcli --config-dir ${configDirectory} mb --ignore-existing "local/$bucket"`,
    `  mcli --config-dir ${configDirectory} anonymous set none "local/$bucket"`,
    "done",
  ].join("\n");
  runDocker(composeArguments(["exec", "-T", "s3", "sh", "-ec", initialize, "bootstrap", ...buckets], envFile), {
    quiet: true,
    env: dockerEnvironment,
  });
}

try {
  const options = parseOptions(process.argv.slice(2));
  ensureLocalEnvironmentFile();
  const environment = options.acceptance ? readExampleEnvironment() : readLocalEnvironment();
  const envFile = localEnvironmentFile;
  let dockerEnvironment = safeProcessEnvironment();
  if (options.acceptance) {
    ensureSandboxEgressNetwork();
    dockerEnvironment = safeProcessEnvironment(createAcceptanceEnvironment(buildAcceptanceSandboxImage(), options.runs, options.simulator));
  }
  if (options.preview && !options.acceptance) {
    if (environment.PREVIEW_GATEWAY_ENABLED !== "true") {
      throw new Error("Configura PREVIEW_GATEWAY_ENABLED=true y claves RSA en infra/.env antes de iniciar el gateway.");
    }
    if ([environment.PREVIEW_TOKEN_KEY_ID, environment.PREVIEW_TOKEN_PRIVATE_KEY, environment.PREVIEW_TOKEN_PUBLIC_KEYS]
      .some((value) => value.toLowerCase().includes("replace-with"))) {
      throw new Error("Configura las claves RSA activas y públicas en infra/.env; no se inició el gateway.");
    }
    ensureSandboxEgressNetwork();
  }
  if (options.publishing && !options.acceptance) {
    if (environment.PUBLISHING_ENABLED !== "true") throw new Error("Configura PUBLISHING_ENABLED=true antes de iniciar el origen público.");
    if (environment.SANDBOX_DRIVER !== "rootless") throw new Error("Publicar requiere que el runtime sandbox local esté habilitado y validado en Compose.");
  }
  if (options.preview || options.publishing || options.acceptance) options.localDomains = true;
  const profiles = [
    ...(options.web || options.publishing || options.acceptance ? ["--profile", "web"] : []),
    ...(options.worker || options.publishing || options.acceptance ? ["--profile", "worker"] : []),
    ...(options.publishing || options.acceptance ? ["--profile", "publishing"] : []),
    ...(options.preview || options.acceptance ? ["--profile", "preview"] : []),
    ...(options.publishing || options.acceptance ? ["--profile", "runtime"] : []),
    ...(options.localDomains ? ["--profile", "local-domains"] : []),
    ...(options.acceptance ? ["--profile", "acceptance-http"] : []),
  ];
  runDocker(composeArguments([
    ...profiles,
    "up",
    ...(options.acceptance ? ["--build"] : []),
    "--detach",
    "--wait",
  ], envFile), { env: dockerEnvironment });
  initializeStorageBuckets(envFile, dockerEnvironment);
  if (options.acceptance) {
    migrateAcceptanceDatabase(envFile, dockerEnvironment);
    await verifyLocalHttpsRoutes();
    await verifyLocalHttpPreviewRoute();
  }
  if (options.acceptance && options.simulator) {
    console.log("Simulador de excavación local activo: sin llamadas al proveedor ni generación de imágenes.");
  }
  console.log("Postgres, Redis y S3 local están disponibles; los buckets siguen siendo privados.");
  if (options.web) console.log("La aplicación web está disponible en http://localhost:3000.");
  if (options.worker) console.log("El worker está activo; los runs terminan con orchestrator_pending hasta integrar el orquestador.");
  if (options.publishing) console.log("El worker y el origen local de publicación están activos detrás de *.games.localhost.");
  if (options.localDomains) console.log("El router local conserva HTTPS con la CA interna de Caddy para app.localhost, *.preview.localhost y *.games.localhost.");
  if (options.acceptance) console.log("BrowserOS puede usar http://127.0.0.1:3000 y la ruta HTTP de preview ligada a loopback; la ruta HTTPS sigue intacta.");
  if (options.acceptance) console.log(`Aceptación local activa: app, gateway, origen y controlador listos; runs de generación ${options.runs ? "habilitados" : "apagados"}; herramientas de assets externos bloqueadas; credenciales de prueba efímeras no persistidas.`);
} catch (error) {
  reportInfrastructureError(error);
}
