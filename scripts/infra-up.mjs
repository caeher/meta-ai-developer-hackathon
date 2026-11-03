import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import {
  composeArguments,
  ensureLocalEnvironmentFile,
  exampleEnvironmentFile,
  localEnvironmentFile,
  readExampleEnvironment,
  readLocalEnvironment,
  repositoryRoot,
  reportInfrastructureError,
  runDocker,
} from "./infra-common.mjs";
import { spawnSync } from "node:child_process";

function parseOptions(arguments_) {
  const options = { web: false, worker: false, preview: false, publishing: false, localDomains: false, acceptance: false };

  for (const argument of arguments_) {
    if (argument === "--web") options.web = true;
    else if (argument === "--worker") options.worker = true;
    else if (argument === "--preview") options.preview = true;
    else if (argument === "--publishing") options.publishing = true;
    else if (argument === "--local-domains") options.localDomains = true;
    else if (argument === "--acceptance") options.acceptance = true;
    else throw new Error(`Opción desconocida para infra:up: ${argument}`);
  }

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

function createAcceptanceEnvironment(sandboxImage) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyId = `local-acceptance-${randomUUID()}`;
  const privateKeyBase64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const localToken = () => randomBytes(48).toString("base64url");

  return {
    APP_ORIGIN: "https://app.localhost",
    NEXT_PUBLIC_APP_URL: "https://app.localhost",
    AUTH_ALLOWED_ORIGINS: "https://app.localhost,http://localhost:3000,http://127.0.0.1:3000",
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
    RUNS_ENABLED: "false",
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

function migrateAcceptanceDatabase(environment) {
  const databaseUrl = new URL("postgresql://localhost");
  databaseUrl.username = environment.POSTGRES_USER;
  databaseUrl.password = environment.POSTGRES_PASSWORD;
  databaseUrl.port = environment.POSTGRES_PORT;
  databaseUrl.pathname = `/${environment.POSTGRES_DB}`;
  const safeEnvironment = {
    DATABASE_URL: databaseUrl.toString(),
    DOTENV_CONFIG_PATH: exampleEnvironmentFile,
    PATH: process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
  };
  const migration = join(repositoryRoot, "node_modules", "drizzle-kit", "bin.cjs");
  const result = spawnSync(process.execPath, [migration, "migrate", "--config", "packages/db/drizzle.config.ts"], {
    cwd: repositoryRoot, env: safeEnvironment, stdio: "inherit", windowsHide: true, shell: false,
  });
  if (result.error || result.status !== 0) throw new Error("No se pudieron aplicar las migraciones de la aceptaciÃ³n local.");
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

function initializeStorageBuckets(environment, envFile, dockerEnvironment) {
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
  runDocker(composeArguments(alias, envFile), { quiet: true, env: dockerEnvironment });

  for (const bucket of [environment.S3_BUCKET_PRIVATE, environment.S3_BUCKET_PUBLIC]) {
    runDocker(
      composeArguments([
        ...common,
        "mb",
        "--ignore-existing",
        `local/${bucket}`,
      ], envFile),
      { quiet: true, env: dockerEnvironment },
    );
    runDocker(
      composeArguments([
        ...common,
        "anonymous",
        "set",
        "none",
        `local/${bucket}`,
      ], envFile),
      { quiet: true, env: dockerEnvironment },
    );
  }
}

try {
  const options = parseOptions(process.argv.slice(2));
  if (!options.acceptance) ensureLocalEnvironmentFile();
  const environment = options.acceptance ? readExampleEnvironment() : readLocalEnvironment();
  const envFile = options.acceptance ? exampleEnvironmentFile : localEnvironmentFile;
  let dockerEnvironment = safeProcessEnvironment();
  if (options.acceptance) {
    ensureSandboxEgressNetwork();
    dockerEnvironment = safeProcessEnvironment(createAcceptanceEnvironment(buildAcceptanceSandboxImage()));
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
  ];
  runDocker(composeArguments([
    ...profiles,
    "up",
    ...(options.acceptance ? ["--build"] : []),
    "--detach",
    "--wait",
  ], envFile), { env: dockerEnvironment });
  initializeStorageBuckets(environment, envFile, dockerEnvironment);
  if (options.acceptance) {
    migrateAcceptanceDatabase(environment);
    await verifyLocalHttpsRoutes();
  }
  console.log("Postgres, Redis y S3 local están disponibles; los buckets siguen siendo privados.");
  if (options.web) console.log("La aplicación web está disponible en http://localhost:3000.");
  if (options.worker) console.log("El worker está activo; los runs terminan con orchestrator_pending hasta integrar el orquestador.");
  if (options.publishing) console.log("El worker y el origen local de publicación están activos detrás de *.games.localhost.");
  if (options.localDomains) console.log("El router local sirve app.localhost, *.preview.localhost y *.games.localhost con una CA TLS interna de Caddy en el volumen local.");
  if (options.acceptance) console.log("AceptaciÃ³n local activa: app, gateway, origen y controlador listos; runs de Meta apagados; credenciales de prueba efÃ­meras no persistidas.");
} catch (error) {
  reportInfrastructureError(error);
}
