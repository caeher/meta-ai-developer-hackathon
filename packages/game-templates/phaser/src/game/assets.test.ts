import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface AssetManifest {
  schemaVersion: number;
  policy: string;
  assets: Array<{ path: string; type: string; source: string; license: string }>;
  audio: Array<{ source: string; license: string }>;
}

describe("asset manifest", () => {
  it("lists existing local-only assets with provenance", async () => {
    const manifestUrl = new URL("../../public/assets/manifest.json", import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as AssetManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.assets.length).toBeGreaterThan(0);
    expect(manifest.policy).toContain("No external asset URL");

    for (const asset of manifest.assets) {
      expect(asset.path).toMatch(/^\/assets\/[a-z0-9-]+\.svg$/);
      expect(asset.source).toContain("Original vector artwork");
      expect(asset.license).toBe("project-original");
      await access(new URL(`../../public${asset.path}`, import.meta.url));
    }

    expect(manifest.audio).toEqual([
      expect.objectContaining({ source: expect.stringContaining("synthesized by src/game/audio.ts") }),
    ]);
  });
});
