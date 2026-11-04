import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
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
    // El bootstrap de la plantilla se ejecuta bajo el límite inicial de 1 GiB.
    // Phaser 3.90 con la minificación predeterminada supera ese límite en Docker Desktop.
    minify: false,
  },
});
