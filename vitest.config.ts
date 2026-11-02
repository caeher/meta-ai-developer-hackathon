import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./tests/fixtures/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/game-templates/phaser/src/**/*.test.ts"],
    clearMocks: true,
    testTimeout: process.env.PERSISTENCE_TEST_ENABLED === "1" ? 30_000 : 5_000,
  },
});
