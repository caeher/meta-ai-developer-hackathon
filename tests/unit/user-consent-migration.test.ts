import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { users } from "@meta-game/db";

const upPath = "packages/db/migrations/0015_user_contributor_consent.sql";
const downPath = "packages/db/migrations/0015_user_contributor_consent_down.sql";

describe("users contributor_consent_at (registro Contributor)", () => {
  it("expone contributor_consent_at nullable en el schema de users", () => {
    const column = getTableConfig(users).columns.find((c) => c.name === "contributor_consent_at");
    expect(column).toBeDefined();
    expect(column?.notNull).toBe(false);
  });

  it("la migracion up agrega la columna con backfill solo de adultos", () => {
    expect(existsSync(upPath)).toBe(true);
    const sql = readFileSync(upPath, "utf8");
    expect(sql).toContain("ADD COLUMN");
    expect(sql).toContain("contributor_consent_at");
    expect(sql).toMatch(/WHERE "deleted_at" IS NULL/);
    expect(sql).toMatch(/"contributor_consent_at" IS NULL/);
  });

  it("la migracion down revierte la columna", () => {
    expect(existsSync(downPath)).toBe(true);
    const sql = readFileSync(downPath, "utf8");
    expect(sql).toContain("DROP COLUMN");
    expect(sql).toContain("contributor_consent_at");
  });
});

