import "dotenv/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readLocalEnvironment } from "./infra-common.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");

function isPlaceholderDatabaseUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      url.hostname.toLowerCase() === "placeholder" ||
      decodeURIComponent(url.username).toLowerCase() === "placeholder" ||
      url.pathname.toLowerCase() === "/placeholder"
    );
  } catch {
    return false;
  }
}

function databaseUrlFromLocalEnvironment() {
  const localEnvironmentPath = resolve(repositoryRoot, "infra", ".env");
  if (!existsSync(localEnvironmentPath)) {
    throw new Error("Define DATABASE_URL o ejecuta npm run infra:config para crear la configuración local.");
  }
  const local = readLocalEnvironment();
  const url = new URL("postgresql://127.0.0.1");
  url.username = local.POSTGRES_USER;
  url.password = local.POSTGRES_PASSWORD;
  url.port = String(local.POSTGRES_PORT);
  url.pathname = `/${local.POSTGRES_DB}`;
  return url.toString();
}

export function loadDatabaseEnvironment() {
  if (isPlaceholderDatabaseUrl(process.env.DATABASE_URL)) {
    process.env.DATABASE_URL = databaseUrlFromLocalEnvironment();
  }
  return process.env.DATABASE_URL;
}

export function loadLocalStorageEnvironment() {
  const local = readLocalEnvironment();
  process.env.S3_ENDPOINT ??= `http://127.0.0.1:${local.S3_API_PORT}`;
  process.env.S3_REGION ??= "us-east-1";
  process.env.S3_BUCKET_PRIVATE ??= local.S3_BUCKET_PRIVATE;
  process.env.S3_ACCESS_KEY_ID ??= local.MINIO_ROOT_USER;
  process.env.S3_SECRET_ACCESS_KEY ??= local.MINIO_ROOT_PASSWORD;
}
