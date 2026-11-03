import { z } from "zod";

const localPort = z
  .string()
  .regex(/^\d{1,5}$/, "must be a TCP port")
  .refine((value) => Number(value) >= 1 && Number(value) <= 65535, {
    message: "must be a TCP port",
  });

const bucketName = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);

export const InfraEnvironmentSchema = z
  .object({
    POSTGRES_DB: z.string().min(1).max(63).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    POSTGRES_USER: z.string().min(1).max(63).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    POSTGRES_PASSWORD: z.string().min(16).max(128).regex(/^[A-Za-z0-9._-]+$/),
    POSTGRES_PORT: localPort,
    REDIS_PORT: localPort,
    MINIO_ROOT_USER: z.string().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/),
    MINIO_ROOT_PASSWORD: z.string().min(16).max(128).regex(/^[A-Za-z0-9._-]+$/),
    S3_API_PORT: localPort,
    S3_CONSOLE_PORT: localPort,
    S3_BUCKET_PRIVATE: bucketName,
    S3_BUCKET_PUBLIC: bucketName,
    PUBLISHING_ENABLED: z.enum(["true", "false"]).default("false"),
    PUBLISH_BASE_DOMAIN: z.string().default("games.localhost"),
    PUBLISHING_ORIGIN_PORT: localPort.default("8083"),
    OBSERVABILITY_PORT: localPort.default("9090"),
    META_PRICE_PLAN_INPUT_USD_PER_1M: z.string().max(32).default("").refine((value) => !value || /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)),
    META_PRICE_PLAN_OUTPUT_USD_PER_1M: z.string().max(32).default("").refine((value) => !value || /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)),
    META_PRICE_CODE_INPUT_USD_PER_1M: z.string().max(32).default("").refine((value) => !value || /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)),
    META_PRICE_CODE_OUTPUT_USD_PER_1M: z.string().max(32).default("").refine((value) => !value || /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)),
    META_PRICE_IMAGE_USD: z.string().max(32).default("").refine((value) => !value || /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(value)),
    SANDBOX_DRIVER: z.enum(["disabled", "rootless"]).default("disabled"),
    PREVIEW_GATEWAY_ENABLED: z.enum(["true", "false"]).default("false"),
    PREVIEW_BASE_DOMAIN: z.string().default("preview.localhost"),
    PREVIEW_TOKEN_KEY_ID: z.string().default("replace-with-active-key-id"),
    PREVIEW_TOKEN_PRIVATE_KEY: z.string().default("replace-with-base64-pkcs8-rsa-private-key"),
    PREVIEW_TOKEN_PUBLIC_KEYS: z.string().default("{\"replace-with-active-key-id\":\"replace-with-base64-spki-rsa-public-key\"}"),
    PREVIEW_TOKEN_TTL_SECONDS: z.string().regex(/^\d+$/).default("60"),
    PREVIEW_SESSION_TTL_SECONDS: z.string().regex(/^\d+$/).default("900"),
    APP_ORIGIN: z.string().url().default("http://localhost:3000"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().max(2048).default("").refine((value) => {
      if (!value) return true;
      try {
        const parsed = new URL(value);
        return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
      } catch { return false; }
    }, "OTEL_EXPORTER_OTLP_ENDPOINT must be an HTTP(S) collector URL without credentials"),
    BACKUP_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default("local-key-v1"),
    BACKUP_ENCRYPTION_KEYS: z.string().min(2).max(4096).default('{"local-key-v1":"replace-with-base64-32-byte-key"}'),
    BACKUP_DIR: z.string().min(1).max(512).default("./backups/encrypted"),
    BACKUP_RETENTION_DAYS: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(3650)).default(30),
  })
  .strict()
  .refine(
    (environment) =>
      new Set([
        environment.POSTGRES_PORT,
        environment.REDIS_PORT,
        environment.S3_API_PORT,
        environment.S3_CONSOLE_PORT,
        environment.PUBLISHING_ORIGIN_PORT,
      ]).size === 5,
    {
      message: "infrastructure ports must be distinct",
      path: ["POSTGRES_PORT"],
    },
  )
  .refine((environment) => environment.S3_BUCKET_PRIVATE !== environment.S3_BUCKET_PUBLIC, {
    message: "S3 buckets must be distinct",
    path: ["S3_BUCKET_PUBLIC"],
  });

export type InfraEnvironment = z.infer<typeof InfraEnvironmentSchema>;

const infraEnvironmentKeys = Object.keys(InfraEnvironmentSchema.shape) as Array<
  keyof z.infer<typeof InfraEnvironmentSchema>
>;

export function parseInfraEnvironment(
  source: Record<string, string | undefined>,
): InfraEnvironment {
  const candidate = Object.fromEntries(
    infraEnvironmentKeys.map((key) => [key, source[key]]),
  );
  const result = InfraEnvironmentSchema.safeParse(candidate);

  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid local infrastructure environment fields: ${fields.join(", ")}`);
  }

  return result.data;
}
