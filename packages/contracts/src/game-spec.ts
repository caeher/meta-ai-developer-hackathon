import { z } from "zod";

export const GameGenreSchema = z.enum(["platformer", "puzzle", "shooter", "rpg"]);
export const GameChangeSchema = z.enum(["enemy", "level", "controls", "sound", "assets", "mechanics"]);

export const GameControlsSchema = z.object({
  movement: z.enum(["arrows", "wasd"]),
  action: z.enum(["space", "e"]),
  touch: z.literal(true),
}).strict();

/** Normalized, validated intent passed from chat to the game-generation pipeline. */
export const GameSpecSchema = z.object({
  schemaVersion: z.literal(1),
  genre: GameGenreSchema,
  intent: z.enum(["create", "edit"]),
  objective: z.string().trim().min(1).max(300),
  changes: z.array(GameChangeSchema).max(6),
  controls: GameControlsSchema,
}).strict();

export const GameBrowserVerificationInputSchema = z.object({
  genre: GameGenreSchema,
  controls: GameControlsSchema,
}).strict();

export const GameBrowserVerificationResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  checks: z.array(z.object({
    name: z.string().min(1).max(80),
    status: z.enum(["passed", "failed"]),
    summary: z.string().min(1).max(500),
  }).strict()).max(12),
  consoleErrors: z.array(z.string().max(500)).max(8),
  blockedRequests: z.number().int().nonnegative().max(1000),
}).strict();

export type GameGenre = z.infer<typeof GameGenreSchema>;
export type GameChange = z.infer<typeof GameChangeSchema>;
export type GameControls = z.infer<typeof GameControlsSchema>;
export type GameSpec = z.infer<typeof GameSpecSchema>;
export type GameBrowserVerificationInput = z.infer<typeof GameBrowserVerificationInputSchema>;
export type GameBrowserVerificationResult = z.infer<typeof GameBrowserVerificationResultSchema>;
