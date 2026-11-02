import { z } from "zod";

const positiveInteger = (fallback: number, maximum: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(maximum)).default(fallback);

export const RunEnvironmentSchema = z.object({
  RUNS_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  REDIS_URL: z.string().url().refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol)).default("redis://127.0.0.1:6379"),
  USER_MAX_CONCURRENT_JOBS: positiveInteger(1, 100),
  PROJECT_MAX_RUN_STEPS: positiveInteger(20, 1000),
  RUN_MAX_TOKENS: positiveInteger(16_000, 2_000_000),
  USER_DAILY_TOKEN_LIMIT: positiveInteger(100_000, 20_000_000),
  USER_DAILY_IMAGE_LIMIT: positiveInteger(10, 100_000),
});

export type RunEnvironment = z.infer<typeof RunEnvironmentSchema>;

const keys = Object.keys(RunEnvironmentSchema.shape) as Array<keyof typeof RunEnvironmentSchema.shape>;

export function parseRunEnvironment(source: Record<string, string | undefined>): RunEnvironment {
  const candidate = Object.fromEntries(keys.map((key) => [key, source[key]]));
  const result = RunEnvironmentSchema.safeParse(candidate);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid run environment fields: ${fields.join(", ")}`);
  }
  return result.data;
}
