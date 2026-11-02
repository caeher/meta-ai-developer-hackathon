import Phaser from "phaser";
import "./style.css";
import { gameAudio } from "./game/audio";
import { BootScene } from "./game/BootScene";
import { HudScene } from "./game/HudScene";
import { PlayScene } from "./game/PlayScene";
import {
  GAME_CONTROL_EVENT,
  GAME_LABELS,
  GAME_SNAPSHOT_EVENT,
  GAME_WIDTH,
  GAME_HEIGHT,
  isGameGenre,
} from "./game/types";
import type { ControlMessage, GameControl, GameGenre, GameSnapshot } from "./game/types";

declare global {
  interface Window {
    __GAME_TEST__?: Readonly<{ getState: () => GameSnapshot | null }>;
  }
}

const canvasParent = document.querySelector<HTMLElement>("#game");
const status = document.querySelector<HTMLElement>("#game-status");
const actionButton = document.querySelector<HTMLButtonElement>('[data-control="action"]');
const genreQuery = new URLSearchParams(window.location.search).get("genre");
const genre: GameGenre = isGameGenre(genreQuery) ? genreQuery : "platformer";
const actionLabel: Readonly<Record<GameGenre, string>> = {
  platformer: "Saltar",
  puzzle: "Interactuar",
  shooter: "Disparar",
  rpg: "Usar",
};

if (!canvasParent) throw new Error("game_mount_missing");
document.title = `Forja · ${GAME_LABELS[genre]}`;
if (actionButton) {
  actionButton.textContent = actionLabel[genre];
  actionButton.setAttribute("aria-label", actionLabel[genre]);
}
document.querySelectorAll<HTMLButtonElement>('[data-control="up"], [data-control="down"]').forEach((button) => {
  button.hidden = genre === "platformer" || genre === "shooter";
});

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: canvasParent,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: "#1a1b26",
  scene: [BootScene, PlayScene, HudScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
  },
  physics: {
    default: "arcade",
    arcade: { gravity: { x: 0, y: 560 }, debug: false },
  },
  render: { antialias: true, roundPixels: true },
  fps: { target: 60, forceSetTimeOut: false },
});
game.registry.set("genre", genre);

const activeControls = new Set<GameControl>();
const pointerControls = new Map<number, GameControl>();

function emit(message: ControlMessage): void {
  game.events.emit(GAME_CONTROL_EVENT, message);
}

function setControl(control: GameControl, pressed: boolean): void {
  if (activeControls.has(control) === pressed) return;
  if (pressed) activeControls.add(control);
  else activeControls.delete(control);
  emit({ kind: "control", control, pressed });
}

function releaseControls(): void {
  for (const control of activeControls) emit({ kind: "control", control, pressed: false });
  activeControls.clear();
  pointerControls.clear();
}

function controlFromKey(key: string): GameControl | undefined {
  if (key === "ArrowLeft" || key.toLowerCase() === "a") return "left";
  if (key === "ArrowRight" || key.toLowerCase() === "d") return "right";
  if (key === "ArrowUp" || key.toLowerCase() === "w") return "up";
  if (key === "ArrowDown" || key.toLowerCase() === "s") return "down";
  if (key === " " || key === "Space" || key === "Spacebar" || key.toLowerCase() === "e") return "action";
  return undefined;
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("button, input, textarea, select")) return;
  const control = controlFromKey(event.key);
  if (control) {
    event.preventDefault();
    if (!event.repeat) setControl(control, true);
    return;
  }
  if (event.repeat) return;
  const command = event.key.toLowerCase() === "r" ? "restart"
    : event.key.toLowerCase() === "p" ? "pause"
      : event.key.toLowerCase() === "m" ? "mute" : undefined;
  if (command) emit({ kind: "command", command });
}

function onKeyUp(event: KeyboardEvent): void {
  const control = controlFromKey(event.key);
  if (control) setControl(control, false);
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-control]");
  const control = button?.dataset.control;
  if (!button || !isControl(control)) return;
  event.preventDefault();
  pointerControls.set(event.pointerId, control);
  setControl(control, true);
}

function onPointerUp(event: PointerEvent): void {
  const control = pointerControls.get(event.pointerId);
  if (!control) return;
  pointerControls.delete(event.pointerId);
  setControl(control, false);
}

function onControlClick(event: MouseEvent): void {
  if (event.detail !== 0) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-control]");
  const control = button?.dataset.control;
  if (!isControl(control)) return;
  setControl(control, true);
  setControl(control, false);
}

function onCommandClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const command = target.closest<HTMLButtonElement>("button[data-command]")?.dataset.command;
  if (command === "pause" || command === "mute" || command === "restart") emit({ kind: "command", command });
}

function onSnapshot(snapshot: GameSnapshot): void {
  if (status) {
    const phase = snapshot.phase === "playing" ? "En curso" : snapshot.phase === "won" ? "Victoria" : "Derrota";
    status.textContent = `${GAME_LABELS[snapshot.genre]}. ${phase}. Objetivo ${snapshot.score} de ${snapshot.target}. Vidas ${snapshot.lives}.`;
  }
  const muteButton = document.querySelector<HTMLButtonElement>('[data-command="mute"]');
  if (muteButton) {
    muteButton.textContent = snapshot.muted ? "Activar sonido" : "Silenciar";
    muteButton.setAttribute("aria-pressed", String(snapshot.muted));
  }
  const pauseButton = document.querySelector<HTMLButtonElement>('[data-command="pause"]');
  if (pauseButton) {
    pauseButton.textContent = snapshot.paused ? "Continuar" : "Pausa";
    pauseButton.setAttribute("aria-label", snapshot.paused ? "Continuar juego" : "Pausar juego");
    pauseButton.setAttribute("aria-pressed", String(snapshot.paused));
  }
}

function onDestroy(): void {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("blur", releaseControls);
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("pointerup", onPointerUp);
  document.removeEventListener("pointercancel", onPointerUp);
  document.removeEventListener("click", onControlClick);
  document.removeEventListener("click", onCommandClick);
  game.events.off(GAME_SNAPSHOT_EVENT, onSnapshot);
  void gameAudio.close();
}

window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);
window.addEventListener("blur", releaseControls);
document.addEventListener("pointerdown", onPointerDown);
document.addEventListener("pointerup", onPointerUp);
document.addEventListener("pointercancel", onPointerUp);
document.addEventListener("click", onControlClick);
document.addEventListener("click", onCommandClick);
game.events.on(GAME_SNAPSHOT_EVENT, onSnapshot);
game.events.once("destroy", onDestroy);

if (import.meta.env.DEV) {
  Object.defineProperty(window, "__GAME_TEST__", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      getState: (): GameSnapshot | null => game.registry.get("publicSnapshot") as GameSnapshot | undefined ?? null,
    }),
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => game.destroy(true));
}

function isControl(value: string | undefined): value is GameControl {
  return value === "left" || value === "right" || value === "up" || value === "down" || value === "action";
}
