import { GAME_OBJECTIVES } from "./types";
import type { GameControl, GameGenre, GameState } from "./types";

export function createGameState(genre: GameGenre): GameState {
  const position = initialPosition(genre);
  return {
    genre,
    phase: "playing",
    score: 0,
    lives: 3,
    x: position.x,
    y: position.y,
    moves: 0,
    actions: 0,
    collectedIds: [],
  };
}

export function moveTo(state: GameState, x: number, y: number, countMove = true): GameState {
  if (state.phase !== "playing" || !Number.isFinite(x) || !Number.isFinite(y)) return state;
  return { ...state, x, y, moves: state.moves + (countMove ? 1 : 0) };
}

export function moveGrid(
  state: GameState,
  control: Extract<GameControl, "left" | "right" | "up" | "down">,
  columns: number,
  rows: number,
  walls: ReadonlySet<string> = new Set(),
): GameState {
  if (state.phase !== "playing") return state;
  const delta = control === "left" ? [-1, 0] : control === "right" ? [1, 0] : control === "up" ? [0, -1] : [0, 1];
  const x = Math.max(0, Math.min(columns - 1, state.x + delta[0]!));
  const y = Math.max(0, Math.min(rows - 1, state.y + delta[1]!));
  if (x === state.x && y === state.y) return state;
  if (walls.has(`${x},${y}`)) return state;
  return moveTo(state, x, y);
}

export function collectObjective(state: GameState, id: string): GameState {
  if (state.phase !== "playing" || !id || state.collectedIds.includes(id)) return state;
  return { ...state, score: state.score + 1, collectedIds: [...state.collectedIds, id] };
}

export function recordAction(state: GameState): GameState {
  if (state.phase !== "playing") return state;
  return { ...state, actions: state.actions + 1 };
}

export function takeDamage(state: GameState): GameState {
  if (state.phase !== "playing") return state;
  const lives = Math.max(0, state.lives - 1);
  return { ...state, lives, phase: lives === 0 ? "lost" : "playing" };
}

export function completeGame(state: GameState): GameState {
  if (state.phase !== "playing" || state.score < GAME_OBJECTIVES[state.genre]) return state;
  return { ...state, phase: "won" };
}

export function restartGame(genre: GameGenre): GameState {
  return createGameState(genre);
}

function initialPosition(genre: GameGenre): Readonly<{ x: number; y: number }> {
  if (genre === "platformer") return { x: 80, y: 465 };
  if (genre === "shooter") return { x: 480, y: 480 };
  return { x: 1, y: 1 };
}
