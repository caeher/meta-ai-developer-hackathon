import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const phaserGlobalBundle = readFileSync(fileURLToPath(new URL("../../../node_modules/phaser/dist/phaser.min.js", import.meta.url)));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [{
    name: "serve-pinned-phaser-global-for-asset-preview",
    configureServer(server) {
      server.middlewares.use("/fixtures/phaser.min.js", (request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") return next();
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        if (request.method === "HEAD") return response.end();
        response.end(phaserGlobalBundle);
      });
    },
  }],
  server: { host: "0.0.0.0", port: 4175, strictPort: true },
});
