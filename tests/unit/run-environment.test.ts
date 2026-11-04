import { describe, expect, it } from "vitest";
import { parseRunEnvironment } from "@meta-game/config";

describe("configuración de runs", () => {
  it("mantiene deshabilitada la API de runs por defecto", () => {
    expect(parseRunEnvironment({})).toMatchObject({
      RUNS_ENABLED: false,
      RUNS_SIMULATOR_ENABLED: false,
      PUBLISHING_ENABLED: false,
      REDIS_URL: "redis://127.0.0.1:6379",
      USER_MAX_CONCURRENT_JOBS: 1,
      PROJECT_MAX_RUN_STEPS: 20,
      RUN_MAX_TOKENS: 32_000,
      RUN_MAX_DURATION_MS: 600_000,
      USER_DAILY_TOKEN_LIMIT: 100_000,
      USER_DAILY_IMAGE_LIMIT: 10,
    });
  });

  it("rechaza valores inválidos sin mostrar datos de entorno", () => {
    expect(() => parseRunEnvironment({ RUNS_ENABLED: "yes" })).toThrow("RUNS_ENABLED");
    expect(() => parseRunEnvironment({ RUNS_SIMULATOR_ENABLED: "true" })).toThrow("RUNS_SIMULATOR_ENABLED requires RUNS_ENABLED");
    expect(() => parseRunEnvironment({ REDIS_URL: "http://localhost:6379" })).toThrow("REDIS_URL");
    expect(() => parseRunEnvironment({ USER_MAX_CONCURRENT_JOBS: "0" })).toThrow("USER_MAX_CONCURRENT_JOBS");
  });
});
