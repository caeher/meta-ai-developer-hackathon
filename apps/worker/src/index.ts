import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { createDatabaseFromEnvironment } from "@meta-game/db";
import { parseRunEnvironment } from "@meta-game/config";
import { pendingOrchestratorHandler } from "./handler";
import { startRunWorkerService } from "./queue";

// Load only the repository .env for local runs. dotenv does not read .env.local here.
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const environment = parseRunEnvironment(process.env);
const database = createDatabaseFromEnvironment();
const service = startRunWorkerService({
  database: database.db,
  redisUrl: environment.REDIS_URL,
  handler: pendingOrchestratorHandler,
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await service.close();
  await database.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
