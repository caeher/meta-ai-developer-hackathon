import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "../..",
  testMatch: ["tests/game-templates/*.spec.ts", "tests/e2e/generation.spec.ts"],
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4174",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "npm --prefix packages/game-templates/phaser run dev -- --host 127.0.0.1 --port 4174 --strictPort",
    cwd: "../..",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
