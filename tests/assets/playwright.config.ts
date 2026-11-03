import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["inspect-preview.spec.ts", "edit-sprite-preview.spec.ts", "create-tileset-preview.spec.ts", "create-tilemap-preview.spec.ts", "pack-spritesheet-preview.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 45_000,
  use: { baseURL: "http://127.0.0.1:4175" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "npx vite --config tests/assets/preview/vite.config.ts --host 127.0.0.1 --port 4175 --strictPort",
    cwd: "../..",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
