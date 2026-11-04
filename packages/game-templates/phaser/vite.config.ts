import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const phaserModulePath = resolve("node_modules/phaser/dist/phaser.esm.min.js");

function localPhaserModule(): Plugin {
  return {
    name: "local-phaser-module",
    configureServer(server) {
      server.middlewares.use("/phaser.esm.min.js", async (_request, response, next) => {
        try {
          const source = await readFile(phaserModulePath);
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-cache");
          response.end(source);
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "phaser.esm.min.js",
        source: await readFile(phaserModulePath),
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [localPhaserModule()],
  server: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
  },
  build: {
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      external: ["phaser"],
      maxParallelFileOps: 8,
    },
    // El bootstrap de la plantilla se ejecuta bajo el límite inicial de 1 GiB.
    // Phaser 3.90 con la minificación predeterminada supera ese límite en Docker Desktop.
    minify: false,
  },
});
