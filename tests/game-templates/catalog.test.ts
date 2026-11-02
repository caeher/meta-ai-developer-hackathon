import { describe, expect, it } from "vitest";
import catalog from "../../packages/game-templates/presets/catalog.json";
import { GAME_GENRES, GAME_HELP, GAME_LABELS, GAME_OBJECTIVES, isGameGenre } from "../../packages/game-templates/phaser/src/game/types";

describe("game preset catalog", () => {
  it("matches every playable preset, its controls and objective count", () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.presets.map((preset) => preset.id)).toEqual(GAME_GENRES);
    for (const preset of catalog.presets) {
      expect(isGameGenre(preset.id)).toBe(true);
      if (!isGameGenre(preset.id)) continue;
      expect(preset.name).toBe(GAME_LABELS[preset.id]);
      expect(preset.objectiveCount).toBe(GAME_OBJECTIVES[preset.id]);
      expect(preset.controls).toContain("action");
      expect(preset.objective.length).toBeGreaterThan(10);
      expect(preset.defeat.length).toBeGreaterThan(10);
      expect(preset.restart).toBe("R");
      expect(GAME_HELP[preset.id]).toBeTruthy();
    }
  });
});
