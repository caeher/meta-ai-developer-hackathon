import {
  composeArguments,
  ensureLocalEnvironmentFile,
  readLocalEnvironment,
  reportInfrastructureError,
  runDocker,
} from "./infra-common.mjs";

try {
  ensureLocalEnvironmentFile();
  readLocalEnvironment();
  runDocker(composeArguments(["config", "--quiet"]));
  console.log("Docker Compose y la configuración local son válidos.");
} catch (error) {
  reportInfrastructureError(error);
}
