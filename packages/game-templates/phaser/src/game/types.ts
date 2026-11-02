export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;

export const GAME_GENRES = ["platformer", "puzzle", "shooter", "rpg"] as const;
export type GameGenre = (typeof GAME_GENRES)[number];
export type GamePhase = "playing" | "won" | "lost";
export type GameControl = "left" | "right" | "up" | "down" | "action";
export type GameCommand = "pause" | "mute" | "restart";

export type ControlMessage =
  | Readonly<{ kind: "control"; control: GameControl; pressed: boolean }>
  | Readonly<{ kind: "command"; command: GameCommand }>;

export interface GameState {
  readonly genre: GameGenre;
  readonly phase: GamePhase;
  readonly score: number;
  readonly lives: number;
  readonly x: number;
  readonly y: number;
  readonly moves: number;
  readonly actions: number;
  readonly collectedIds: readonly string[];
}

export interface GameSnapshot extends GameState {
  readonly velocityY: number;
  readonly target: number;
  readonly targetsRemaining: number;
  readonly projectilesActive: number;
  readonly muted: boolean;
  readonly paused: boolean;
  readonly assetsReady: boolean;
}

export const GAME_OBJECTIVES: Readonly<Record<GameGenre, number>> = {
  platformer: 3,
  puzzle: 3,
  shooter: 5,
  rpg: 3,
};

export const GAME_LABELS: Readonly<Record<GameGenre, string>> = {
  platformer: "Plataformas",
  puzzle: "Puzzle",
  shooter: "Shooter 2D",
  rpg: "RPG top-down",
};

export const GAME_HELP: Readonly<Record<GameGenre, string>> = {
  platformer: "Flechas para moverte · espacio para saltar · recoge 3 cristales y llega al portal",
  puzzle: "Flechas para mover la ficha · evita las trampas · recoge 3 cristales y abre el portal",
  shooter: "Flechas para moverte · espacio para disparar · derrota a los 5 drones",
  rpg: "Flechas para caminar · E para interactuar · recoge 3 runas y llega al portal",
};

export const GAME_CONTROL_EVENT = "template:control";
export const GAME_SNAPSHOT_EVENT = "template:snapshot";

export function isGameGenre(value: string | null): value is GameGenre {
  return value !== null && GAME_GENRES.some((genre) => genre === value);
}
