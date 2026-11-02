import "server-only";
import { z } from "zod";

export const OFFICIAL_META_BASE_URL = "https://api.meta.ai/v1";

const ModelIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export interface MetaConfig {
  apiKey: string;
  baseUrl: string;
  modelPlan: string;
  modelCode: string;
  modelImage: string;
  timeoutMs: number;
}

export class MetaConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaConfigurationError";
  }
}

function readBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || OFFICIAL_META_BASE_URL;

  try {
    const parsed = new URL(raw);
    const isOfficial = parsed.protocol === "https:" &&
      parsed.hostname === "api.meta.ai" &&
      parsed.port === "" &&
      parsed.pathname.replace(/\/$/, "") === "/v1" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "";

    if (isOfficial) return OFFICIAL_META_BASE_URL;
  } catch {
    // Convert URL parser details to a stable, secret-free configuration error.
  }

  throw new MetaConfigurationError("META_BASE_URL must use the official https://api.meta.ai/v1 endpoint.");
}

function readModel(name: string, value: string | undefined, fallback: string): string {
  const parsed = ModelIdSchema.safeParse(value?.trim() || fallback);
  if (!parsed.success) {
    throw new MetaConfigurationError(`${name} must be a valid model ID.`);
  }
  return parsed.data;
}

function readTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 60_000;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 120_000) {
    throw new MetaConfigurationError("META_TIMEOUT_MS must be an integer between 1000 and 120000.");
  }

  return parsed;
}

export function loadMetaConfig(env: Record<string, string | undefined> = process.env): MetaConfig {
  const apiKey = env.META_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new MetaConfigurationError("META_API_KEY is required. Set it in the process environment or local .env.local file.");
  }
  if (apiKey !== apiKey.trim() || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) {
    throw new MetaConfigurationError("META_API_KEY has an invalid format.");
  }

  return {
    apiKey,
    baseUrl: readBaseUrl(env.META_BASE_URL),
    modelPlan: readModel("META_MODEL_PLAN", env.META_MODEL_PLAN, "muse-spark-1.3-contributor"),
    modelCode: readModel("META_MODEL_CODE", env.META_MODEL_CODE, "muse-spark-1.3-contributor"),
    modelImage: readModel("META_MODEL_IMAGE", env.META_MODEL_IMAGE, "muse-image-1.0"),
    timeoutMs: readTimeout(env.META_TIMEOUT_MS),
  };
}
