import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { createDatabaseFromEnvironment, getPreviewTarget } from "@meta-game/db";
import { createRedisPreviewStore, loadPreviewVerifierKeyRing, parsePreviewBaseDomain } from "@meta-game/preview";
import { createPreviewGateway } from "./gateway";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return value === undefined ? fallback : 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 60 && parsed <= maximum ? parsed : 0;
}

function parseAppOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) return undefined;
    return parsed.origin;
  } catch { return undefined; }
}

if (process.env.PREVIEW_GATEWAY_ENABLED !== "true") throw new Error("preview_gateway_disabled");
const baseDomain = parsePreviewBaseDomain(process.env.PREVIEW_BASE_DOMAIN);
const appOrigin = parseAppOrigin(process.env.APP_ORIGIN);
const keyRing = loadPreviewVerifierKeyRing(process.env.PREVIEW_TOKEN_PUBLIC_KEYS);
const sessionTtlSeconds = positiveInteger(process.env.PREVIEW_SESSION_TTL_SECONDS, 900, 3600);
if (!baseDomain || !appOrigin || !keyRing || !sessionTtlSeconds ||
  (process.env.PREVIEW_TOKEN_TTL_SECONDS !== undefined && process.env.PREVIEW_TOKEN_TTL_SECONDS !== "60")) {
  throw new Error("preview_gateway_configuration_invalid");
}

const database = createDatabaseFromEnvironment();
const store = createRedisPreviewStore(process.env.REDIS_URL ?? "");
const gateway = createPreviewGateway({
  baseDomain,
  appOrigin,
  sessionTtlSeconds,
  store,
  keyRing,
  resolveTarget: (projectId) => getPreviewTarget(database.db, projectId),
});

const port = Number(process.env.PREVIEW_GATEWAY_PORT ?? 8080);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("preview_gateway_port_invalid");
await gateway.start(port, "0.0.0.0");
process.stdout.write(`preview_gateway_listening 0.0.0.0:${port}\n`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await gateway.close();
  await store.close();
  await database.close();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
