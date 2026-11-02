import Phaser from "phaser";
import { parseGeneratedAssetManifest, type GeneratedRuntimeAsset } from "./generated-assets";

export class BootScene extends Phaser.Scene {
  private failedAssets: string[] = [];
  private generatedAssets: GeneratedRuntimeAsset[] = [];

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
    this.load.json("generated-assets-manifest", "assets/generated/manifest.json");
    this.load.on("loaderror", (file: Phaser.Loader.File) => {
      if (file.key !== "generated-assets-manifest") this.failedAssets.push(file.key);
    });
  }

  create(): void {
    const manifestExists = this.cache.json.exists("generated-assets-manifest");
    if (manifestExists) {
      const rawManifest: unknown = this.cache.json.get("generated-assets-manifest");
      this.generatedAssets = parseGeneratedAssetManifest(rawManifest) ?? [];
      const rawAssets = typeof rawManifest === "object" && rawManifest !== null && "assets" in rawManifest
        ? rawManifest.assets
        : undefined;
      if (this.generatedAssets.length === 0 && Array.isArray(rawAssets) && rawAssets.length > 0) {
        this.failedAssets.push("generated-assets-manifest");
      }
    }
    this.registry.set("generatedAssets", this.generatedAssets);
    if (this.generatedAssets.length > 0) {
      for (const asset of this.generatedAssets) {
        if (asset.frameColumns > 1 || asset.frameRows > 1) {
          this.load.spritesheet(asset.key, asset.path, { frameWidth: asset.frameWidth, frameHeight: asset.frameHeight });
        } else {
          this.load.image(asset.key, asset.path);
        }
      }
      this.load.once("complete", () => this.finishBoot());
      this.load.start();
      return;
    }
    this.finishBoot();
  }

  private finishBoot(): void {
    this.registry.set("assetsReady", this.failedAssets.length === 0);
    this.registry.set("missingAssets", [...this.failedAssets]);
    this.scene.start("PlayScene");
  }
}
