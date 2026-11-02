import { describe, expect, it } from "vitest";
import { GET } from "../apps/web/app/api/health/route";
import { ApiErrorSchema, HealthResponseSchema } from "@meta-game/contracts";
import { parsePublicEnvironment } from "@meta-game/config";
import { getNodeVersionError } from "../scripts/check-node-version.mjs";

describe("health endpoint", () => {
  it("returns a minimal liveness response without exposing environment values", async () => {
    const response = GET();
    const payload: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual({ status: "ok", service: "web" });
    expect(HealthResponseSchema.safeParse(payload).success).toBe(true);
    expect(HealthResponseSchema.safeParse({
      status: "ok",
      service: "web",
      META_API_KEY: "must-not-be-returned",
    }).success).toBe(false);
  });
});

describe("shared API error contract", () => {
  it("accepts a bounded public error and rejects extra diagnostic fields", () => {
    expect(ApiErrorSchema.safeParse({
      error: { code: "NOT_FOUND", message: "No se encontró el recurso." },
    }).success).toBe(true);
    expect(ApiErrorSchema.safeParse({
      error: {
        code: "INTERNAL_ERROR",
        message: "Error interno.",
        stack: "private diagnostic",
      },
    }).success).toBe(false);
  });
});

describe("public environment parser", () => {
  it("only accepts the public URLs and never includes invalid values in its error", () => {
    expect(parsePublicEnvironment({
      APP_ORIGIN: "http://localhost:3000",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      META_API_KEY: "private-value",
    })).toEqual({
      APP_ORIGIN: "http://localhost:3000",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });

    expect(() => parsePublicEnvironment({ APP_ORIGIN: "not a URL" })).toThrow(
      "APP_ORIGIN",
    );

    let errorMessage = "";
    try {
      parsePublicEnvironment({ APP_ORIGIN: "private-value" });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toContain("APP_ORIGIN");
    expect(errorMessage).not.toContain("private-value");
  });
});

describe("Node engine guard", () => {
  it("accepts major 24 and rejects other majors", () => {
    expect(getNodeVersionError("24.22.1")).toBeUndefined();
    expect(getNodeVersionError("23.9.0")).toContain("Node.js 24.x is required");
    expect(getNodeVersionError("25.0.0")).toContain("Node.js 24.x is required");
  });
});
