export type DiggingCell = "#" | "." | "R" | "G" | "E" | " ";

export type DiggingBoard = Readonly<{
  cells: readonly (readonly DiggingCell[])[];
  player: Readonly<{ x: number; y: number }>;
  start: Readonly<{ x: number; y: number }>;
  exit: Readonly<{ x: number; y: number }>;
  gemsRemaining: number;
}>;

export type DiggingMove = Readonly<{
  board: DiggingBoard;
  moved: boolean;
  collectedGem: boolean;
  reachedExit: boolean;
}>;

export const DIGGING_LEVELS: readonly (readonly string[])[] = [
  [
    "##############",
    "#P..G..R..G  #",
    "#.###.#.###..#",
    "#G..R...G....#",
    "#..##.##..##.#",
    "#G..R..G.....#",
    "#..........E.#",
    "##############",
  ],
  [
    "##############",
    "#P.G..R.G....#",
    "#.##..##.##..#",
    "#..G..R..G...#",
    "#.##.###.##..#",
    "#G..R.G......#",
    "#..........E.#",
    "##############",
  ],
  [
    "##############",
    "#P..G.R..G...#",
    "#.##...##.##.#",
    "#G..R...G....#",
    "#..###..##...#",
    "#G.R..G......#",
    "#..........E.#",
    "##############",
  ],
];

const COLUMNS = 14;
const ROWS = 8;

export function parseDiggingLevel(rows: readonly string[]): DiggingBoard {
  if (rows.length !== ROWS || rows.some((row) => row.length !== COLUMNS)) throw new Error("digging_level_dimensions_invalid");
  let start: { x: number; y: number } | undefined;
  let exit: { x: number; y: number } | undefined;
  let gemsRemaining = 0;
  const cells = rows.map((row, y) => [...row].map((value, x): DiggingCell => {
    if (value === "P") {
      if (start) throw new Error("digging_level_player_invalid");
      start = { x, y };
      return " ";
    }
    if (value === "E") {
      if (exit) throw new Error("digging_level_exit_invalid");
      exit = { x, y };
      return "E";
    }
    if (value === "G") gemsRemaining += 1;
    if (["#", ".", "R", "G", " "].includes(value)) return value as DiggingCell;
    throw new Error("digging_level_cell_invalid");
  }));
  if (!start || !exit || gemsRemaining !== 6) throw new Error("digging_level_objectives_invalid");
  return { cells, player: start, start, exit, gemsRemaining };
}

export function moveDiggingPlayer(
  board: DiggingBoard,
  direction: "left" | "right" | "up" | "down",
): DiggingMove {
  const delta = direction === "left" ? [-1, 0]
    : direction === "right" ? [1, 0]
      : direction === "up" ? [0, -1] : [0, 1];
  const x = board.player.x + delta[0]!;
  const y = board.player.y + delta[1]!;
  const cell = board.cells[y]?.[x];
  if (cell === undefined || cell === "#" || cell === "R") {
    return { board, moved: false, collectedGem: false, reachedExit: false };
  }
  const collectedGem = cell === "G";
  const cells = board.cells.map((row) => [...row]);
  if (cell === "." || cell === "G") cells[y]![x] = " ";
  return {
    board: {
      ...board,
      cells,
      player: { x, y },
      gemsRemaining: board.gemsRemaining - Number(collectedGem),
    },
    moved: true,
    collectedGem,
    reachedExit: cell === "E",
  };
}

export function advanceFallingRocks(board: DiggingBoard): Readonly<{ board: DiggingBoard; hitPlayer: boolean }> {
  const cells = board.cells.map((row) => [...row]);
  let hitPlayer = false;
  for (let y = cells.length - 2; y > 0; y -= 1) {
    for (let x = 1; x < (cells[y]?.length ?? 1) - 1; x += 1) {
      if (cells[y]?.[x] !== "R" || cells[y + 1]?.[x] !== " ") continue;
      cells[y]![x] = " ";
      cells[y + 1]![x] = "R";
      if (board.player.x === x && board.player.y === y + 1) hitPlayer = true;
    }
  }
  return { board: { ...board, cells }, hitPlayer };
}
