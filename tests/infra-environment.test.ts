import { describe, expect, it } from "vitest";
import { parseInfraEnvironment } from "../packages/config/src/infra-environment";

const validEnvironment = {
  POSTGRES_DB: "meta_game",
  POSTGRES_USER: "meta_game",
  POSTGRES_PASSWORD: "local-only-postgres-password-change-me-2026",
  POSTGRES_PORT: "5432",
  REDIS_PORT: "6379",
  MINIO_ROOT_USER: "meta_game_local",
  MINIO_ROOT_PASSWORD: "local-only-s3-password-change-me-2026",
  S3_API_PORT: "9000",
  S3_CONSOLE_PORT: "9001",
  S3_BUCKET_PRIVATE: "meta-game-private",
  S3_BUCKET_PUBLIC: "meta-game-public",
  PREVIEW_GATEWAY_ENABLED: "false",
  PREVIEW_BASE_DOMAIN: "preview.example.test",
  PREVIEW_TOKEN_KEY_ID: "replace-with-active-key-id",
  PREVIEW_TOKEN_PRIVATE_KEY: "replace-with-base64-pkcs8-rsa-private-key",
  PREVIEW_TOKEN_PUBLIC_KEYS: "{\"replace-with-active-key-id\":\"replace-with-base64-spki-rsa-public-key\"}",
  PREVIEW_TOKEN_TTL_SECONDS: "60",
  PREVIEW_SESSION_TTL_SECONDS: "900",
  APP_ORIGIN: "http://localhost:3000",
};

describe("local infrastructure environment", () => {
  it("accepts the documented local service configuration", () => {
    expect(parseInfraEnvironment(validEnvironment)).toEqual(validEnvironment);
  });

  it("rejects invalid ports without including secret values in errors", () => {
    const secret = "never-print-this-in-an-error";
    const invalidEnvironment = {
      ...validEnvironment,
      POSTGRES_PASSWORD: secret,
      POSTGRES_PORT: "70000",
    };

    expect(() => parseInfraEnvironment(invalidEnvironment)).toThrow(
      "Invalid local infrastructure environment fields: POSTGRES_PORT",
    );

    try {
      parseInfraEnvironment(invalidEnvironment);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("requires separate loopback ports and private/public buckets", () => {
    expect(() =>
      parseInfraEnvironment({ ...validEnvironment, REDIS_PORT: validEnvironment.POSTGRES_PORT }),
    ).toThrow("POSTGRES_PORT");

    expect(() =>
      parseInfraEnvironment({
        ...validEnvironment,
        S3_BUCKET_PUBLIC: validEnvironment.S3_BUCKET_PRIVATE,
      }),
    ).toThrow("S3_BUCKET_PUBLIC");
  });
});
