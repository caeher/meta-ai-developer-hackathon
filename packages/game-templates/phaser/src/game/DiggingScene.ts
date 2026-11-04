import Phaser from "phaser";
import { gameAudio } from "./audio";
import { createGameState, moveTo, recordAction, restartGame, takeDamage } from "./logic";
import { advanceFallingRocks, DIGGING_LEVELS, moveDiggingPlayer, parseDiggingLevel, type DiggingBoard } from "./digging";
import { GAME_CONTROL_EVENT, GAME_SNAPSHOT_EVENT } from "./types";
import type { ControlMessage, GameControl, GameSnapshot, GameState } from "./types";

const BOARD_LEFT = 144;
const BOARD_TOP = 104;
const TILE = 48;
const LEVEL_SECONDS = 90;

export class DiggingScene extends Phaser.Scene {
  private state: GameState = createGameState("puzzle");
  private board: DiggingBoard = parseDiggingLevel(DIGGING_LEVELS[0]!);
  private graphics!: Phaser.GameObjects.Graphics;
  private levelIndex = 0;
  private levelElapsedMs = 0;
  private nextRockFallAt = 0;
  private nextSnapshotAt = 0;
  private paused = false;

  constructor() {
    super("PlayScene");
  }

  create(): void {
    this.state = createGameState("puzzle");
    this.board = parseDiggingLevel(DIGGING_LEVELS[0]!);
    this.levelIndex = 0;
    this.levelElapsedMs = 0;
    this.paused = false;
    this.registry.set("paused", false);
    this.registry.set("worldHint", "Excava tierra, recoge seis esmeraldas y llega a la salida. Las rocas caen.");
    this.add.rectangle(480, 300, 740, 408, 0x1a1b26, 0.5).setStrokeStyle(1, 0x414868);
    this.graphics = this.add.graphics().setDepth(4);
    this.game.events.on(GAME_CONTROL_EVENT, this.onControl, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    this.scene.launch("HudScene");
    this.nextRockFallAt = this.time.now + 800;
    this.redraw();
    this.publishSnapshot();
  }

  update(time: number, delta: number): void {
    if (this.paused || this.state.phase !== "playing") return;
    this.levelElapsedMs += delta;
    if (this.levelElapsedMs >= LEVEL_SECONDS * 1_000) {
      this.levelElapsedMs = 0;
      this.damagePlayer("Se acabó el tiempo de este nivel.");
      return;
    }
    if (time >= this.nextRockFallAt) {
      this.nextRockFallAt = time + 800;
      const result = advanceFallingRocks(this.board);
      this.board = result.board;
      if (result.hitPlayer) this.damagePlayer("Una roca cayó sobre el minero.");
      else this.redraw();
    }
    if (time >= this.nextSnapshotAt) {
      this.nextSnapshotAt = time + 200;
      this.publishSnapshot();
    }
  }

  private readonly onControl = (message: ControlMessage): void => {
    if (message.kind === "command") {
      if (message.command === "restart") this.restart();
      else if (message.command === "pause") {
        this.paused = !this.paused;
        this.registry.set("paused", this.paused);
        this.publishSnapshot();
      } else {
        gameAudio.toggleMute();
        this.publishSnapshot();
      }
      return;
    }
    if (!message.pressed || this.state.phase !== "playing") return;
    if (message.control === "action") {
      this.state = recordAction(this.state);
      this.tryExit();
      this.publishSnapshot();
      return;
    }
    this.move(message.control);
  };

  private move(direction: Extract<GameControl, "left" | "right" | "up" | "down">): void {
    const result = moveDiggingPlayer(this.board, direction);
    if (!result.moved) return;
    this.board = result.board;
    this.state = moveTo(this.state, this.board.player.x, this.board.player.y);
    if (result.collectedGem) {
      const id = `level-${this.levelIndex + 1}-gem-${this.state.score + 1}`;
      this.state = { ...this.state, score: this.state.score + 1, collectedIds: [...this.state.collectedIds, id] };
      gameAudio.playTone(790, 0.1);
    } else gameAudio.playTone(390, 0.035);
    this.redraw();
    if (result.reachedExit) this.tryExit();
    this.publishSnapshot();
  }

  private tryExit(): void {
    if (this.board.player.x !== this.board.exit.x || this.board.player.y !== this.board.exit.y) return;
    if (this.board.gemsRemaining > 0) {
      this.registry.set("worldHint", `La salida sigue cerrada: faltan ${this.board.gemsRemaining} esmeraldas.`);
      gameAudio.playTone(210, 0.08);
      return;
    }
    if (this.levelIndex + 1 === DIGGING_LEVELS.length) {
      this.state = { ...this.state, phase: "won" };
      this.registry.set("worldHint", "¡La mina está a salvo! Reinicia para volver a jugar.");
      gameAudio.playTone(1_040, 0.2);
      this.publishSnapshot();
      return;
    }
    this.levelIndex += 1;
    this.board = parseDiggingLevel(DIGGING_LEVELS[this.levelIndex]!);
    this.state = {
      ...this.state,
      score: 0,
      x: this.board.start.x,
      y: this.board.start.y,
      moves: 0,
      actions: 0,
      collectedIds: [],
    };
    this.levelElapsedMs = 0;
    this.registry.set("worldHint", `Nivel ${this.levelIndex + 1}: busca seis esmeraldas y evita las rocas.`);
    this.redraw();
    this.publishSnapshot();
  }

  private damagePlayer(hint: string): void {
    this.state = takeDamage(this.state);
    if (this.state.phase === "playing") {
      this.board = { ...this.board, player: this.board.start };
      this.state = moveTo(this.state, this.board.start.x, this.board.start.y, false);
      this.registry.set("worldHint", `${hint} Te queda(n) ${this.state.lives} vida(s).`);
    } else this.registry.set("worldHint", "Fin de la partida. Pulsa R o Reiniciar para volver a intentarlo.");
    this.redraw();
    this.publishSnapshot();
  }

  private restart(): void {
    this.state = restartGame("puzzle");
    this.board = parseDiggingLevel(DIGGING_LEVELS[0]!);
    this.levelIndex = 0;
    this.levelElapsedMs = 0;
    this.paused = false;
    this.registry.set("paused", false);
    this.nextRockFallAt = this.time.now + 800;
    this.registry.set("worldHint", "Excava tierra, recoge seis esmeraldas y llega a la salida. Las rocas caen.");
    this.redraw();
    this.publishSnapshot();
  }

  private redraw(): void {
    this.graphics.clear();
    for (let y = 0; y < this.board.cells.length; y += 1) {
      for (let x = 0; x < (this.board.cells[y]?.length ?? 0); x += 1) {
        const cell = this.board.cells[y]![x]!;
        const left = BOARD_LEFT + x * TILE;
        const top = BOARD_TOP + y * TILE;
        this.drawCell(left, top, cell);
      }
    }
    const playerX = BOARD_LEFT + this.board.player.x * TILE + TILE / 2;
    const playerY = BOARD_TOP + this.board.player.y * TILE + TILE / 2;
    this.graphics.fillStyle(0x7dcfff, 1);
    this.graphics.fillRoundedRect(playerX - 11, playerY - 3, 22, 20, 5);
    this.graphics.fillStyle(0xff9e64, 1);
    this.graphics.fillCircle(playerX, playerY - 10, 11);
    this.graphics.fillStyle(0x1a1b26, 1);
    this.graphics.fillRect(playerX + 2, playerY - 13, 3, 3);
  }

  private drawCell(left: number, top: number, cell: string): void {
    const inset = 3;
    this.graphics.fillStyle(0x202438, 1);
    this.graphics.fillRect(left + 1, top + 1, TILE - 2, TILE - 2);
    if (cell === "#") {
      this.graphics.fillStyle(0x414868, 1);
      this.graphics.fillRect(left + inset, top + inset, TILE - inset * 2, TILE - inset * 2);
      this.graphics.lineStyle(2, 0x565f89, 0.9);
      this.graphics.strokeRect(left + 7, top + 7, TILE - 14, TILE - 14);
    } else if (cell === ".") {
      this.graphics.fillStyle(0x70543e, 1);
      this.graphics.fillRect(left + inset, top + inset, TILE - inset * 2, TILE - inset * 2);
      this.graphics.fillStyle(0xc19a6b, 0.9);
      this.graphics.fillCircle(left + 13, top + 16, 2);
      this.graphics.fillCircle(left + 33, top + 30, 2);
    } else if (cell === "R") {
      this.graphics.fillStyle(0x9aa5ce, 1);
      this.graphics.fillCircle(left + TILE / 2, top + TILE / 2, TILE * 0.36);
      this.graphics.fillStyle(0xc0caf5, 0.75);
      this.graphics.fillCircle(left + 18, top + 17, 5);
      this.graphics.lineStyle(2, 0x565f89, 1);
      this.graphics.strokeCircle(left + TILE / 2, top + TILE / 2, TILE * 0.36);
    } else if (cell === "G") {
      this.graphics.fillStyle(0x9ece6a, 1);
      this.graphics.fillTriangle(left + 24, top + 8, left + 40, top + 24, left + 24, top + 40);
      this.graphics.fillStyle(0x7dcfff, 1);
      this.graphics.fillTriangle(left + 24, top + 8, left + 24, top + 40, left + 8, top + 24);
      this.graphics.lineStyle(2, 0xc0caf5, 1);
      this.graphics.strokeTriangle(left + 24, top + 8, left + 40, top + 24, left + 24, top + 40);
    } else if (cell === "E") {
      const open = this.board.gemsRemaining === 0;
      this.graphics.fillStyle(open ? 0x9ece6a : 0xbb9af7, 1);
      this.graphics.fillRect(left + 10, top + 6, TILE - 20, TILE - 12);
      this.graphics.fillStyle(0x1a1b26, 1);
      this.graphics.fillRect(left + 16, top + 12, TILE - 32, TILE - 24);
      this.graphics.fillStyle(0xff9e64, 1);
      this.graphics.fillCircle(left + 31, top + 25, 2);
    }
  }

  private publishSnapshot(): void {
    const snapshot: GameSnapshot = Object.freeze({
      ...this.state,
      velocityY: 0,
      collectedIds: Object.freeze([...this.state.collectedIds]),
      target: 6,
      targetsRemaining: this.board.gemsRemaining,
      projectilesActive: 0,
      muted: gameAudio.isMuted(),
      paused: this.paused,
      assetsReady: this.registry.get("assetsReady") === true,
      generatedAssetKeys: Object.freeze([]),
      level: this.levelIndex + 1,
      levels: DIGGING_LEVELS.length,
      remainingSeconds: Math.max(0, Math.ceil(LEVEL_SECONDS - this.levelElapsedMs / 1_000)),
    });
    this.registry.set("publicSnapshot", snapshot);
    this.game.events.emit(GAME_SNAPSHOT_EVENT, snapshot);
  }

  private onShutdown(): void {
    this.game.events.off(GAME_CONTROL_EVENT, this.onControl, this);
    this.graphics?.destroy();
    this.paused = false;
  }
}

export function localDiggingProjectSpec(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0] ?? "";
  const requestedName = firstLine.replace(/^(?:crea|create|haz|make)\s+/i, "").split(/[,.:!?]/, 1)[0]?.trim();
  const title = (requestedName && requestedName.length > 0 ? requestedName : "Excavación de esmeraldas").slice(0, 48);
  const movement = /\bwasd\b/i.test(prompt) ? "wasd" : "arrows";
  const movementLabel = movement === "wasd" ? "WASD" : "Flechas";
  return `${JSON.stringify({
    schemaVersion: 1,
    genre: "puzzle",
    intent: "create",
    objective: "Excava tres niveles, recoge seis esmeraldas por nivel, esquiva rocas que caen y abre la salida.",
    changes: ["level", "controls", "mechanics"],
    controls: { movement, action: "space", touch: true },
    mode: "digging",
    title,
    actionLabel: "Abrir salida",
    controlHelp: `${movementLabel} para excavar · recoge seis esmeraldas · llega a la salida · botones táctiles visibles`,
  }, null, 2)}\n`;
}
