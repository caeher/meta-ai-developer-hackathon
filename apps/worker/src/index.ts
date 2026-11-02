import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDatabaseFromEnvironment } from "@meta-game/db";
import { parseRunEnvironment } from "@meta-game/config";
import { loadMetaConfig, MetaClient } from "@meta-game/meta";
import { SandboxControllerClient } from "@meta-game/sandbox";
import { createSkillRouter } from "@meta-game/skills";
import { createAgentRunHandler } from "./agent/orchestrator";
import { createPostgresAgentRunStore } from "./agent/store";
import { pendingOrchestratorHandler } from "./handler";
import { startRunWorkerService } from "./queue";

// Load only the repository .env for local runs. dotenv does not read .env.local here.
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const environment = parseRunEnvironment(process.env);
const database = createDatabaseFromEnvironment();
const handler = environment.RUNS_ENABLED
  ? await createEnabledAgentHandler()
  : pendingOrchestratorHandler;
const service = startRunWorkerService({
  database: database.db,
  redisUrl: environment.REDIS_URL,
  handler,
});

async function createEnabledAgentHandler() {
  if (process.env.SANDBOX_DRIVER !== "rootless") {
    throw new Error("RUNS_ENABLED requires SANDBOX_DRIVER=rootless on the dedicated Linux host");
  }
  const controllerUrl = process.env.SANDBOX_CONTROLLER_URL;
  const controllerToken = process.env.SANDBOX_CONTROLLER_TOKEN;
  if (!controllerUrl || !controllerToken) {
    throw new Error("RUNS_ENABLED requires SANDBOX_CONTROLLER_URL and SANDBOX_CONTROLLER_TOKEN");
  }
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const store = createPostgresAgentRunStore(database.db);
  const skills = await createSkillRouter({ rootDir });
  const sandbox = new SandboxControllerClient(controllerUrl, controllerToken);
  return createAgentRunHandler({
    store,
    meta: new MetaClient(loadMetaConfig()),
    sandbox,
    skills,
    maxSteps: environment.PROJECT_MAX_RUN_STEPS,
    maxTokens: environment.RUN_MAX_TOKENS,
    maxDurationMs: environment.RUN_MAX_DURATION_MS,
  });
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await service.close();
  await database.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
