import {
  composeArguments,
  ensureLocalEnvironmentFile,
  readLocalEnvironment,
  reportInfrastructureError,
  runDocker,
} from "./infra-common.mjs";

function parseOptions(arguments_) {
  const options = { web: false };

  for (const argument of arguments_) {
    if (argument === "--web") options.web = true;
    else throw new Error(`Opción desconocida para infra:up: ${argument}`);
  }

  return options;
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
  const profiles = options.web ? ["--profile", "web"] : [];
  runDocker(composeArguments([...profiles, "up", "--detach", "--wait"]));
  initializeStorageBuckets(environment);
  console.log("Postgres, Redis y S3 local están disponibles; los buckets siguen siendo privados.");
  if (options.web) console.log("La aplicación web está disponible en http://localhost:3000.");
} catch (error) {
  reportInfrastructureError(error);
}
