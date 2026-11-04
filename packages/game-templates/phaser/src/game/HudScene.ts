import Phaser from "phaser";
import { GAME_HELP, GAME_LABELS } from "./types";
import type { GameSnapshot } from "./types";

export class HudScene extends Phaser.Scene {
  private details!: Phaser.GameObjects.Text;
  private help!: Phaser.GameObjects.Text;
  private previousText = "";
  private previousHint = "";

  constructor() {
    super("HudScene");
  }

  create(): void {
    const genre = this.registry.get("genre") as GameSnapshot["genre"];
    this.add.rectangle(0, 0, 960, 76, 0x1a1b26, 0.94).setOrigin(0).setScrollFactor(0).setDepth(100);
    const gameTitle = this.registry.get("gameTitle");
    this.add.text(22, 13, `FORJA · ${typeof gameTitle === "string" ? gameTitle : GAME_LABELS[genre]}`, {
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      fontSize: "20px",
      fontStyle: "bold",
      color: "#c0caf5",
    }).setScrollFactor(0).setDepth(101);
    this.details = this.add.text(22, 42, "Preparando juego…", {
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      fontSize: "14px",
      color: "#7dcfff",
    }).setScrollFactor(0).setDepth(101);
    const controlHelp = this.registry.get("controlHelp") as string | undefined;
    this.help = this.add.text(938, 12, controlHelp ?? GAME_HELP[genre], {
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      fontSize: "11px",
      color: "#a9b1d6",
      align: "right",
      wordWrap: { width: 470 },
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(101);
  }

  update(): void {
    const snapshot = this.registry.get("publicSnapshot") as GameSnapshot | undefined;
    if (!snapshot) return;
    const hint = this.registry.get("worldHint") as string | undefined;
    if (hint && hint !== this.previousHint) {
      this.previousHint = hint;
      const controlHelp = this.registry.get("controlHelp") as string | undefined;
      this.help.setText(`${controlHelp ?? GAME_HELP[snapshot.genre]}\n${hint}`);
    }
    const status = snapshot.phase === "won" ? "¡Victoria! · R para reiniciar"
      : snapshot.phase === "lost" ? "Derrota · R para volver a jugar"
        : snapshot.paused ? "Pausa"
          : snapshot.level && snapshot.levels && snapshot.remainingSeconds !== undefined
            ? `Gemas ${snapshot.score}/${snapshot.target} · Nivel ${snapshot.level}/${snapshot.levels} · ${formatTime(snapshot.remainingSeconds)} · Vidas ${snapshot.lives}${snapshot.muted ? " · Sonido apagado" : ""}`
            : `Cristales ${snapshot.score}/${snapshot.target} · Vidas ${snapshot.lives}${snapshot.muted ? " · Sonido apagado" : ""}`;
    if (status === this.previousText) return;
    this.previousText = status;
    this.details.setText(status);
    this.details.setColor(snapshot.phase === "won" ? "#9ece6a" : snapshot.phase === "lost" ? "#f7768e" : "#7dcfff");
  }
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}
