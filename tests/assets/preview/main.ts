import Phaser from "phaser";

type Sample = Readonly<{ name: string; at: number }>;
type PreviewState = Readonly<{
  loaded: boolean;
  atlasFrames: string[];
  pivots: Record<string, { custom: boolean; x: number; y: number }>;
  animationFrames: string[];
  animationFps: number;
  observedFrames: Sample[];
  playerBottom: number;
  floorTop: number;
  collisionEnabled: boolean;
  error?: string;
}>;

declare global {
  interface Window {
    __ASSET_PREVIEW_TEST__?: () => PreviewState;
  }
}

const ATLAS_URL = "/fixtures/hero.json";
const HERO_URL = "/fixtures/hero.png";
const TILES_URL = "/fixtures/terrain.png";
const ANIMATION_URL = "/fixtures/run.json";
const TILESET_URL = "/fixtures/terrain.json";
const TILEMAP_URL = "/fixtures/level.json";

class AssetPreviewScene extends Phaser.Scene {
  private actor?: Phaser.Physics.Arcade.Sprite;
  private observedFrames: Sample[] = [];
  private lastFrame = "";
  private state: PreviewState = {
    loaded: false,
    atlasFrames: [],
    pivots: {},
    animationFrames: [],
    animationFps: 0,
    observedFrames: [],
    playerBottom: 0,
    floorTop: 64,
    collisionEnabled: false,
  };

  constructor() { super("AssetPreviewScene"); }

  preload(): void {
    this.load.atlas("hero", HERO_URL, ATLAS_URL);
    this.load.image("terrain", TILES_URL);
    this.load.json("run", ANIMATION_URL);
    this.load.json("terrainDescriptor", TILESET_URL);
    this.load.json("level", TILEMAP_URL);
    this.load.once("loaderror", (file: Phaser.Loader.File) => {
      this.state = { ...this.state, error: `load_error:${file.key}` };
    });
  }

  create(): void {
    const texture = this.textures.get("hero");
    const atlasFrames = texture.getFrameNames();
    const pivots = Object.fromEntries(atlasFrames.map((name) => {
      const frame = texture.get(name);
      return [name, { custom: frame.customPivot, x: frame.pivotX, y: frame.pivotY }];
    }));
    const animation = this.cache.json.get("run") as { key: string; fps: number; frames: string[] };
    const tilemap = this.cache.json.get("level") as { width: number; height: number; tileWidth: number; tileHeight: number; layers: Array<{ tiles: Array<{ x: number; y: number; index: number }>; collides: boolean }> };
    const tileset = this.cache.json.get("terrainDescriptor") as { name: string; tileWidth: number; tileHeight: number };

    this.anims.create({
      key: animation.key,
      frames: animation.frames.map((frame) => ({ key: "hero", frame })),
      frameRate: animation.fps,
      repeat: -1,
    });

    const data = Array.from({ length: tilemap.height }, () => Array.from({ length: tilemap.width }, () => -1));
    const ground = tilemap.layers[0];
    for (const tile of ground?.tiles ?? []) data[tile.y]![tile.x] = tile.index;
    const map = this.make.tilemap({ data, tileWidth: tileset.tileWidth, tileHeight: tileset.tileHeight });
    const tileImage = map.addTilesetImage(tileset.name, "terrain", tileset.tileWidth, tileset.tileHeight, 0, 0);
    if (!tileImage) throw new Error("tileset_image_missing");
    const layer = map.createLayer(0, tileImage, 0, 0);
    if (!layer) throw new Error("tilemap_layer_missing");
    if (ground?.collides) layer.setCollision([1]);
    const floorTile = layer.getTileAt(0, 4);

    this.physics.world.setBounds(0, 0, 128, 96);
    this.actor = this.physics.add.sprite(24, 38, "hero", animation.frames[0]);
    this.actor.body?.setSize(10, 12).setOffset(3, 2);
    this.physics.add.collider(this.actor, layer);
    this.actor.play(animation.key);
    this.state = {
      loaded: true,
      atlasFrames,
      pivots,
      animationFrames: [...animation.frames],
      animationFps: animation.fps,
      observedFrames: this.observedFrames,
      playerBottom: this.actor.body?.bottom ?? 0,
      floorTop: floorTile?.pixelY ?? 64,
      collisionEnabled: floorTile?.collides === true,
    };
    window.__ASSET_PREVIEW_TEST__ = () => this.readState();
  }

  update(): void {
    const actor = this.actor;
    if (!actor) return;
    const name = actor.frame.name;
    if (name !== this.lastFrame) {
      this.lastFrame = name;
      this.observedFrames.push({ name, at: performance.now() });
      if (this.observedFrames.length > 128) this.observedFrames.shift();
    }
    this.state = { ...this.state, observedFrames: this.observedFrames, playerBottom: actor.body?.bottom ?? 0 };
  }

  private readState(): PreviewState {
    return { ...this.state, observedFrames: [...this.observedFrames], playerBottom: this.actor?.body?.bottom ?? 0 };
  }
}

const game = new Phaser.Game({
  type: Phaser.CANVAS,
  parent: "preview",
  width: 128,
  height: 96,
  backgroundColor: "#1a1b26",
  pixelArt: true,
  physics: { default: "arcade", arcade: { gravity: { x: 0, y: 520 }, debug: false } },
  scene: [AssetPreviewScene],
  scale: { mode: Phaser.Scale.NONE, width: 128, height: 96 },
  render: { antialias: false, roundPixels: true },
  fps: { target: 60, forceSetTimeOut: true },
});

game.events.once(Phaser.Core.Events.DESTROY, () => { delete window.__ASSET_PREVIEW_TEST__; });
