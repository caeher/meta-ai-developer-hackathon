import {
  composeArguments,
  ensureLocalEnvironmentFile,
  reportInfrastructureError,
  runDocker,
} from "./infra-common.mjs";

try {
  if (process.argv.length > 2) {
    throw new Error("infra:down no elimina volúmenes. Usa el comando de reset explícito de docs/local-development.md para borrarlos.");
  }

  ensureLocalEnvironmentFile();
  runDocker(composeArguments([
    "--profile", "web",
    "--profile", "worker",
    "--profile", "preview",
    "--profile", "publishing",
    "--profile", "local-domains",
    "down",
  ]));
  console.log("Servicios detenidos. Los volúmenes y datos se conservaron.");
} catch (error) {
  reportInfrastructureError(error);
}
