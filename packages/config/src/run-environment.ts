import { z } from "zod";

const positiveInteger = (fallback: number, maximum: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(maximum)).default(fallback);
const retentionDays = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(3_650)).default(30);

const runEnvironmentObjectSchema = z.object({
  RUNS_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  RUNS_SIMULATOR_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  PUBLISHING_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  RESOURCE_LIFECYCLE_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  PREVIEW_SESSION_TTL_SECONDS: positiveInteger(900, 86_400),
  REDIS_URL: z.string().url().refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol)).default("redis://127.0.0.1:6379"),
  USER_MAX_CONCURRENT_JOBS: positiveInteger(1, 100),
  USER_MAX_PROJECTS: positiveInteger(50, 10_000),
  USER_MAX_STORAGE_MB: positiveInteger(1_024, 1_048_576),
  SANDBOX_IDLE_TTL_SECONDS: positiveInteger(900, 86_400),
  PROJECT_DELETION_RETENTION_DAYS: retentionDays,
  PROJECT_MAX_RUN_STEPS: positiveInteger(20, 1000),
  RUN_MAX_TOKENS: positiveInteger(32_000, 2_000_000),
  RUN_MAX_DURATION_MS: positiveInteger(600_000, 3_600_000),
  USER_DAILY_TOKEN_LIMIT: positiveInteger(100_000, 20_000_000),
  USER_DAILY_IMAGE_LIMIT: positiveInteger(10, 100_000),
});

export const RunEnvironmentSchema = runEnvironmentObjectSchema;

export type RunEnvironment = z.infer<typeof RunEnvironmentSchema>;

const keys = Object.keys(runEnvironmentObjectSchema.shape) as Array<keyof typeof runEnvironmentObjectSchema.shape>;

export function parseRunEnvironment(source: Record<string, string | undefined>): RunEnvironment {
  const candidate = Object.fromEntries(keys.map((key) => [key, source[key]]));
  const result = RunEnvironmentSchema.safeParse(candidate);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid run environment fields: ${fields.join(", ")}`);
  }
  if (result.data.RUNS_SIMULATOR_ENABLED && !result.data.RUNS_ENABLED) {
    throw new Error("Invalid run environment fields: RUNS_SIMULATOR_ENABLED requires RUNS_ENABLED");
  }
  return result.data;
}
