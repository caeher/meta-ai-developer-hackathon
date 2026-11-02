import { defineConfig, globalIgnores } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/**/*.{js,jsx,ts,tsx}"],
    plugins: {
      "@next/next": nextPlugin,
    },
    settings: {
      next: {
        rootDir: "apps/web",
      },
    },
    rules: nextPlugin.configs.recommended.rules,
  },
  globalIgnores([
    "**/node_modules/**",
    "**/.next/**",
    "coverage/**",
    "next-env.d.ts",
  ]),
]);
