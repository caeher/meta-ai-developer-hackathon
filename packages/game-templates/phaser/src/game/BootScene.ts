import Phaser from "phaser";

export class BootScene extends Phaser.Scene {
  private failedAssets: string[] = [];

  constructor() {
    super("BootScene");
  }

  preload(): void {
    this.load.setPath(import.meta.env.BASE_URL);
    this.load.image("player", "assets/player.svg");
    this.load.image("crystal", "assets/crystal.svg");
    this.load.image("enemy", "assets/enemy.svg");
    this.load.image("gate", "assets/gate.svg");
    this.load.image("tile", "assets/tile.svg");
    this.load.image("bullet", "assets/bullet.svg");
    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      this.failedAssets.push(file.key);
    });
  }

  create(): void {
    this.registry.set("assetsReady", this.failedAssets.length === 0);
    this.registry.set("missingAssets", [...this.failedAssets]);
    this.scene.start("PlayScene");
  }
}
