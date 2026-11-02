import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@meta-game/db";
import { createRepositories } from "@meta-game/db";
import { createPublicationArtifactStorageFromEnvironment } from "@meta-game/storage";
import { createPublishingOriginServer } from "./server";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
if (process.env.PUBLISHING_ENABLED !== "true") throw new Error("PUBLISHING_ENABLED=true is required for the public artifact origin");
const baseDomain = process.env.PUBLISH_BASE_DOMAIN ?? "";
const connectionString = process.env.PUBLISH_READ_DATABASE_URL ?? "";
const port = Number(process.env.PUBLISHING_ORIGIN_PORT ?? "8083");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PUBLISHING_ORIGIN_PORT inválido");
const database = createDatabase(connectionString, { max: 4 });
const repositories = createRepositories(database.db);
const artifacts = createPublicationArtifactStorageFromEnvironment(process.env, "reader");
const server = createPublishingOriginServer({ baseDomain, publications: repositories.publications, artifacts });

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "0.0.0.0", resolve);
});
process.stdout.write(`publishing_origin_listening port=${port}\n`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  artifacts.close();
  await database.close();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
