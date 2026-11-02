import { describe, expect, it } from "vitest";
import { GAME_GENRES, GAME_OBJECTIVES } from "./types";
import { collectObjective, completeGame, createGameState, moveGrid, moveTo, recordAction, restartGame, takeDamage } from "./logic";

describe("game loop state", () => {
  it.each(GAME_GENRES)("supports victory and restart for %s", (genre) => {
    let state = createGameState(genre);
    for (let index = 0; index < GAME_OBJECTIVES[genre]; index += 1) {
      state = collectObjective(state, `target-${index}`);
    }

    expect(completeGame(state).phase).toBe("won");
    expect(completeGame(createGameState(genre)).phase).toBe("playing");
    expect(restartGame(genre)).toMatchObject({
      genre,
      phase: "playing",
      score: 0,
      lives: 3,
      moves: 0,
      actions: 0,
      collectedIds: [],
    });
  });

  it.each(GAME_GENRES)("supports defeat and terminal-state protection for %s", (genre) => {
    let state = createGameState(genre);
    state = takeDamage(state);
    state = takeDamage(state);
    state = takeDamage(state);

    expect(state).toMatchObject({ phase: "lost", lives: 0 });
    expect(takeDamage(state)).toBe(state);
    expect(recordAction(state)).toBe(state);
    expect(moveTo(state, 1, 2)).toBe(state);
  });

  it("deduplicates collectibles and gates victory on the per-genre objective", () => {
    let state = createGameState("rpg");
    state = collectObjective(state, "rune-1");
    state = collectObjective(state, "rune-1");
    expect(state.score).toBe(1);
    expect(completeGame(state).phase).toBe("playing");
  });

  it("moves on a bounded grid and rejects walls without counting a move", () => {
    const start = createGameState("puzzle");
    const moved = moveGrid(start, "right", 12, 7);
    expect(moved).toMatchObject({ x: 2, y: 1, moves: 1 });
    expect(moveGrid(moved, "up", 12, 7)).toMatchObject({ x: 2, y: 0, moves: 2 });
    expect(moveGrid(start, "left", 12, 7)).toMatchObject({ x: 0, y: 1, moves: 1 });
    expect(moveGrid(moveGrid(start, "left", 12, 7), "left", 12, 7)).toMatchObject({ x: 0, y: 1, moves: 1 });
    expect(moveGrid(moved, "down", 12, 7, new Set(["2,2"]))).toBe(moved);
  });
});
