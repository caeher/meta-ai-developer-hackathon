import { describe, expect, it } from "vitest";
import { advanceFallingRocks, DIGGING_LEVELS, moveDiggingPlayer, parseDiggingLevel } from "./digging";

describe("local digging game levels", () => {
  it("keeps three bounded levels with six gems, a start and an exit", () => {
    expect(DIGGING_LEVELS).toHaveLength(3);
    for (const level of DIGGING_LEVELS) {
      expect(parseDiggingLevel(level).gemsRemaining).toBe(6);
    }
  });

  it("lets the miner dig soil and collect gems while stopping at rock and stone", () => {
    const board = parseDiggingLevel(DIGGING_LEVELS[0]!);
    const dug = moveDiggingPlayer(board, "right");
    expect(dug.moved).toBe(true);
    expect(dug.board.cells[1]![2]).toBe(" ");
    const dugAgain = moveDiggingPlayer(dug.board, "right");
    const collected = moveDiggingPlayer(dugAgain.board, "right");
    expect(collected.collectedGem).toBe(true);
    expect(collected.board.gemsRemaining).toBe(5);
    expect(moveDiggingPlayer(collected.board, "up").moved).toBe(false);
  });

  it("drops rocks into empty cells and reports a collision with the miner", () => {
    const board = parseDiggingLevel([
      "##############", "#P   R      E#", "#     .      #", "#G....G......#",
      "#.G........G.#", "#G....G......#", "#............#", "##############",
    ]);
    const playerBelow = { ...board, player: { x: 5, y: 2 } };
    const dropped = advanceFallingRocks(playerBelow);
    expect(dropped.hitPlayer).toBe(true);
    expect(dropped.board.cells[2]![5]).toBe("R");
  });
});
