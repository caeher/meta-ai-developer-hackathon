import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: [{ find: "next/link", replacement: fileURLToPath(new URL("./LinkFixture.tsx", import.meta.url)) }],
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
