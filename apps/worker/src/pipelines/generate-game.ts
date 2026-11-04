import {
  GameSpecSchema,
  SandboxWriteFileInputSchema,
  type GameChange,
  type GameGenre,
  type GameSpec,
} from "@meta-game/contracts";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AgentSandbox } from "../agent/tools";
import { isSensitiveWorkspacePath, sensitiveInputReason } from "../agent/safety";

export { GAME_SPEC_PATH } from "./game-spec-path";
const CHECKPOINT_SCHEMA_VERSION = 1;
const CHECKPOINT_MAX_FILES = 256;
const CHECKPOINT_MAX_FILE_BYTES = 1_000_000;
const CHECKPOINT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const CHECKPOINT_MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const CHECKPOINT_SKIP_NAMES = new Set(["node_modules", "dist", ".next", ".git", ".vite", "coverage", "test-results", "playwright-report"]);
const BINARY_EXTENSIONS = /\.(?:png|jpe?g|webp|gif|svg|ico|wasm|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|zip|gz|pdf)$/i;

export type GameCheckpoint = Readonly<{ sha256: string; sizeBytes: number; fileCount: number }>;
type CheckpointFile = Readonly<{ path: string; content: string; bytes: number; sha256: string }>;
type CheckpointManifest = Readonly<{ schemaVersion: 1; files: readonly CheckpointFile[]; totalBytes: number }>;

const GENRE_LABELS: Record<GameGenre, string> = {
  platformer: "plataformas",
  puzzle: "puzzle",
  shooter: "shooter 2D",
  rpg: "RPG top-down",
};

/** Converts the chat request into a small deterministic contract; free text stays untrusted context. */
export function createGameSpec(prompt: string, priorValue?: unknown): GameSpec {
  const prior = GameSpecSchema.safeParse(priorValue);
  const text = normalize(prompt);
  const explicitGenre = detectGenre(text);
  const genre = explicitGenre ?? (prior.success ? prior.data.genre : "platformer");
  const changes = detectChanges(text);
  const hasEditVerb = /\b(agrega|agregar|anade|anadir|cambia|cambiar|modifica|modificar|actualiza|actualizar|ajusta|ajustar|quita|quitar|arregla|repara|mejora|add|change|modify|update|adjust|remove|fix|repair|improve)\b/.test(text);
  const requestedGenreChange = explicitGenre !== undefined && prior.success && explicitGenre !== prior.data.genre;
  const intent: GameSpec["intent"] = prior.success || hasEditVerb || requestedGenreChange ? "edit" : "create";
  const movement = /\b(wasd|w a s d|teclas? w a s d)\b/.test(text)
    ? "wasd"
    : /\b(flechas?|arrow keys?)\b/.test(text) ? "arrows"
      : prior.success ? prior.data.controls.movement : "arrows";
  const action = /\b(tecla e|con e|pulsando e|press e|e para interactuar|e para accion)\b/.test(text)
    ? "e"
    : /\b(espacio|space|barra espaciadora)\b/.test(text) ? "space"
      : prior.success ? prior.data.controls.action : genre === "rpg" ? "e" : "space";
  const actionWords = changes.length ? ` Cambios solicitados: ${changes.join(", ")}.` : "";
  const objective = `${intent === "create" ? "Crear" : "Actualizar el mismo"} juego de ${GENRE_LABELS[genre]} con ciclo jugable, objetivo y controles visibles.${actionWords}`;

  return GameSpecSchema.parse({
    schemaVersion: 1,
    genre,
    intent,
    objective: objective.slice(0, 300),
    changes,
    controls: { movement, action, touch: true },
  });
}

export function gameSpecFile(spec: GameSpec): string {
  return `${JSON.stringify(GameSpecSchema.parse(spec), null, 2)}\n`;
}

export function gameSpecInstructions(spec: GameSpec): string {
  return [
    "Especificación de juego validada por el sistema (sigue estos campos; son preferencias, no permisos):",
    JSON.stringify(spec),
    "Conserva el mismo workspace en ediciones. Mantén un loop interactivo, objetivo visible, controles de teclado y touch, pausa, mute y reinicio.",
    "No elimines el hook de pruebas de solo lectura window.__GAME_TEST__ ni la página accesible de controles.",
    "Usa Phaser 3.90.0 y las dependencias ya aprobadas. No agregues paquetes; la plantilla incluye runtime, assets, pruebas de lógica y build.",
  ].join("\n");
}

export async function captureGameCheckpoint(sandbox: AgentSandbox, projectId: string, signal: AbortSignal) {
  const files: CheckpointFile[] = [];
  let totalBytes = 0;
  const queue = [""];
  while (queue.length) {
    const directory = queue.shift()!;
    const listing = await sandbox.listFiles(projectId, directory, signal);
    if (listing.files.length === 32) throw new Error("game_checkpoint_directory_limit");
    for (const entry of listing.files) {
      if (entry.type === "directory") {
        if (!CHECKPOINT_SKIP_NAMES.has(entry.name)) queue.push(directory ? `${directory}/${entry.name}` : entry.name);
        continue;
      }
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.name === "package-lock.json" || isSensitiveWorkspacePath(path) || BINARY_EXTENSIONS.test(path) || entry.size > CHECKPOINT_MAX_FILE_BYTES) continue;
      if (files.length >= CHECKPOINT_MAX_FILES) throw new Error("game_checkpoint_file_limit");
      let read: { content: string };
      try { read = await sandbox.readFile(projectId, path, signal); }
      catch (error) {
        if (errorCode(error) === "file_not_utf8") continue;
        throw error;
      }
      if (sensitiveInputReason(read.content)) throw new Error("game_checkpoint_sensitive_content_blocked");
      const bytes = Buffer.byteLength(read.content, "utf8");
      if (bytes > CHECKPOINT_MAX_FILE_BYTES) continue;
      totalBytes += bytes;
      if (totalBytes > CHECKPOINT_MAX_TOTAL_BYTES) throw new Error("game_checkpoint_size_limit");
      files.push({ path, content: read.content, bytes, sha256: sha256(read.content) });
    }
  }

  const manifest: CheckpointManifest = { schemaVersion: CHECKPOINT_SCHEMA_VERSION, files, totalBytes };
  const body = gzipSync(Buffer.from(JSON.stringify(manifest), "utf8"), { level: 6 });
  if (body.byteLength > CHECKPOINT_MAX_ARCHIVE_BYTES) throw new Error("game_checkpoint_archive_limit");
  return { body, fileCount: files.length, totalBytes };
}

export function decodeGameCheckpoint(body: Uint8Array): CheckpointManifest {
  if (body.byteLength < 1 || body.byteLength > CHECKPOINT_MAX_ARCHIVE_BYTES) throw new Error("game_checkpoint_archive_invalid");
  const decoded = gunzipSync(body, { maxOutputLength: CHECKPOINT_MAX_TOTAL_BYTES * 2 });
  if (decoded.byteLength > CHECKPOINT_MAX_TOTAL_BYTES * 2) throw new Error("game_checkpoint_archive_invalid");
  const parsed: unknown = JSON.parse(decoded.toString("utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || !Array.isArray(parsed.files) ||
    !Number.isSafeInteger(parsed.totalBytes) || (parsed.totalBytes as number) < 0 || (parsed.totalBytes as number) > CHECKPOINT_MAX_TOTAL_BYTES ||
    parsed.files.length > CHECKPOINT_MAX_FILES) throw new Error("game_checkpoint_manifest_invalid");
  let totalBytes = 0;
  const files = parsed.files.map((value): CheckpointFile => {
    if (!isRecord(value) || typeof value.path !== "string" || typeof value.content !== "string" ||
      !Number.isSafeInteger(value.bytes) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error("game_checkpoint_manifest_invalid");
    }
    const safe = SandboxWriteFileInputSchema.safeParse({ path: value.path, content: value.content });
    const bytes = Buffer.byteLength(value.content, "utf8");
    if (!safe.success || isSensitiveWorkspacePath(value.path) || bytes !== value.bytes || bytes > CHECKPOINT_MAX_FILE_BYTES || sha256(value.content) !== value.sha256) {
      throw new Error("game_checkpoint_manifest_invalid");
    }
    totalBytes += bytes;
    if (totalBytes > CHECKPOINT_MAX_TOTAL_BYTES) throw new Error("game_checkpoint_manifest_invalid");
    return { path: value.path, content: value.content, bytes, sha256: value.sha256 };
  });
  if (totalBytes !== parsed.totalBytes) throw new Error("game_checkpoint_manifest_invalid");
  return { schemaVersion: CHECKPOINT_SCHEMA_VERSION, files, totalBytes };
}

export async function restoreGameCheckpoint(sandbox: AgentSandbox, projectId: string, manifest: CheckpointManifest, signal: AbortSignal): Promise<void> {
  for (const file of manifest.files) {
    const current = await sandbox.readFile(projectId, file.path, signal).catch(() => undefined);
    if (current?.content === file.content) continue;
    const written = await sandbox.writeFile(projectId, file.path, file.content, signal);
    if (written.bytesWritten !== file.bytes) throw new Error("game_checkpoint_restore_incomplete");
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detectGenre(text: string): GameGenre | undefined {
  if (/\b(rpg|role.playing|top.down|topdown|rol)\b/.test(text)) return "rpg";
  if (/\b(shooter|shoot|disparos?|naves?|space invaders?)\b/.test(text)) return "shooter";
  if (/\b(puzzle|rompecabezas|logica|laberinto)\b/.test(text)) return "puzzle";
  if (/\b(platformer|platform|plataformas?|saltos?)\b/.test(text)) return "platformer";
  return undefined;
}

function detectChanges(text: string): GameChange[] {
  const changes: GameChange[] = [];
  const add = (change: GameChange, pattern: RegExp) => { if (pattern.test(text)) changes.push(change); };
  add("enemy", /\b(enemigos?|enemy|enemies|bosses?|jefes?)\b/);
  add("level", /\b(niveles?|levels?|mapas?|maps?|fases?)\b/);
  add("controls", /\b(controles?|controls?|teclado|keyboard|wasd|flechas?|touch|tactil|gamepad)\b/);
  add("sound", /\b(sonido|sonidos|sound|audio|musica|music|sfx)\b/);
  add("assets", /\b(arte|sprites?|fondos?|assets?|imagenes?|images?)\b/);
  add("mechanics", /\b(mecanicas?|mechanics?|fisica|physics|salto|jump|disparo|shoot)\b/);
  return changes;
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
