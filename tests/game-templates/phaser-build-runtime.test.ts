import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("runtime Phaser autocontenido", () => {
  it("externaliza el motor al módulo local incluido con el juego estático", async () => {
    const root = new URL("../../packages/game-templates/phaser/", import.meta.url);
    const [viteConfig, html] = await Promise.all([
      readFile(new URL("vite.config.ts", root), "utf8"),
      readFile(new URL("index.html", root), "utf8"),
    ]);

    expect(viteConfig).toContain('external: ["phaser"]');
    expect(viteConfig).toContain("maxParallelFileOps: 8");
    expect(viteConfig).toContain('fileName: "phaser.esm.min.js"');
    expect(html).toContain('type="importmap"');
    expect(html).toContain('"phaser":"./phaser.esm.min.js"');
  });
});
