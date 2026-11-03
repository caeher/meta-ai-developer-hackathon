import Phaser from "phaser";
import { addGeneratedTileset, applyGeneratedTilesetCollisions, parseGeneratedTilesetMetadata } from "../../../packages/game-templates/phaser/src/game/tilesets";
import { createGeneratedTilemap } from "../../../packages/game-templates/phaser/src/game/tilemaps";
import { parseGeneratedSpritesheetAtlas } from "../../../packages/game-templates/phaser/src/game/generated-assets";

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
  tileset?: {
    name: string;
    firstgid: number;
    localIndexByName: Record<string, number>;
    globalIndexByName: Record<string, number>;
    collisionLocalIndices: number[];
    terrainByLocalIndex: Record<number, string>;
  };
  tileProperties?: { collides: boolean; terrain: string; name: string };
  tilemap?: {
    width: number;
    height: number;
    tileSize: number;
    firstgid: number;
    layerNames: string[];
    layerVisibility: boolean[];
    layerCollision: boolean[];
    backgroundIndices: Array<number | null>;
    floorTileIndex: number;
    emptyTileIndex: number;
    unselectedSolidTileCollides: boolean;
    playerBottom: number;
    freePlayerBottom: number;
  };
  error?: string;
  atlasValid?: boolean;
  atlasTextureSize?: { width: number; height: number };
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
  private testActorBody?: Phaser.Physics.Arcade.Body;
  private freeActorBody?: Phaser.Physics.Arcade.Body;
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
    const mode = new URLSearchParams(window.location.search).get("mode");
    if (mode === "generated-tilemap") {
      this.load.tilemapTiledJSON("generated-map", "/fixtures/generated-tilemap.json");
      this.load.image("generated-map-image", "/fixtures/generated-map-tileset.png");
      this.load.json("generated-map-tileset-metadata", "/fixtures/generated-map-tileset.json");
      this.load.once("loaderror", (file: Phaser.Loader.File) => {
        this.state = { ...this.state, error: `load_error:${file.key}` };
      });
      return;
    }
    if (mode === "packed-spritesheet") {
      this.load.atlas("packed-spritesheet", "/fixtures/generated-spritesheet.png", "/fixtures/generated-spritesheet.json");
      this.load.json("packed-spritesheet-data", "/fixtures/generated-spritesheet.json");
      this.load.json("packed-animation", "/fixtures/generated-animation.json");
      this.load.tilemapTiledJSON("generated-map", "/fixtures/generated-tilemap.json");
      this.load.image("generated-map-image", "/fixtures/generated-map-tileset.png");
      this.load.json("generated-map-tileset-metadata", "/fixtures/generated-map-tileset.json");
      this.load.once("loaderror", (file: Phaser.Loader.File) => {
        this.state = { ...this.state, error: "load_error:" + file.key };
      });
      return;
    }
    if (mode === "generated-tileset") {
      this.load.image("generated-tileset", "/fixtures/generated-tileset.png");
      this.load.json("generated-tileset-metadata", "/fixtures/generated-tileset.json");
      this.load.once("loaderror", (file: Phaser.Loader.File) => {
        this.state = { ...this.state, error: `load_error:${file.key}` };
      });
      return;
    }
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
    const mode = new URLSearchParams(window.location.search).get("mode");
    if (mode === "generated-tilemap") {
      this.createGeneratedTilemapPreview();
      return;
    }
    if (mode === "packed-spritesheet") {
      this.createPackedSpritesheetPreview();
      return;
    }
    if (mode === "generated-tileset") {
      this.createGeneratedTilesetPreview();
      return;
    }
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
    if (!actor) {
      const playerBottom = this.testActorBody?.bottom ?? 0;
      const tilemap = this.state.tilemap
        ? { ...this.state.tilemap, playerBottom, freePlayerBottom: this.freeActorBody?.bottom ?? 0 }
        : undefined;
      this.state = { ...this.state, playerBottom, ...(tilemap ? { tilemap } : {}) };
      return;
    }
    const name = actor.frame.name;
    if (name !== this.lastFrame) {
      this.lastFrame = name;
      this.observedFrames.push({ name, at: performance.now() });
      if (this.observedFrames.length > 128) this.observedFrames.shift();
    }
    const playerBottom = actor.body?.bottom ?? 0;
    const tilemap = this.state.tilemap
      ? { ...this.state.tilemap, playerBottom, freePlayerBottom: this.freeActorBody?.bottom ?? 0 }
      : undefined;
    this.state = {
      ...this.state,
      observedFrames: this.observedFrames,
      playerBottom,
      ...(tilemap ? { tilemap } : {}),
    };
  }

  private readState(): PreviewState {
    return { ...this.state, observedFrames: [...this.observedFrames], playerBottom: this.actor?.body?.bottom ?? this.testActorBody?.bottom ?? 0 };
  }

  private createGeneratedTilesetPreview(): void {
    const metadata = parseGeneratedTilesetMetadata(this.cache.json.get("generated-tileset-metadata"));
    if (!metadata) throw new Error("generated_tileset_metadata_invalid");
    const firstgid = 1;
    const data = Array.from({ length: 6 }, () => Array.from({ length: 8 }, () => -1));
    data[0]![0] = firstgid;
    data[0]![1] = firstgid + 1;
    data[0]![2] = firstgid + 2;
    data[0]![3] = firstgid + 3;
    data[1]![0] = firstgid + 3;
    data[1]![1] = firstgid + 2;
    for (let x = 0; x < 8; x += 1) data[4]![x] = firstgid + 1;

    const map = this.make.tilemap({ data, tileWidth: metadata.tileSize, tileHeight: metadata.tileSize });
    const binding = addGeneratedTileset(map, metadata, "generated-tileset", firstgid);
    const layer = map.createLayer(0, binding.tileset, 0, 0);
    if (!layer) throw new Error("generated_tileset_layer_missing");
    applyGeneratedTilesetCollisions(layer, binding);
    const ground = layer.getTileAt(0, 4);

    this.physics.world.setBounds(0, 0, 128, 96);
    const actor = this.add.rectangle(24, 38, 10, 12, 0xffffff);
    this.physics.add.existing(actor);
    this.testActorBody = actor.body as Phaser.Physics.Arcade.Body;
    this.testActorBody.setSize(10, 12).setOffset(0, 0);
    this.physics.add.collider(actor, layer);
    const localIndex = binding.localIndexByName.ground;
    const tileProperties = binding.tileset.tileProperties as Record<string, { collides?: unknown; terrain?: unknown; name?: unknown }>;
    const groundProperties = localIndex === undefined ? undefined : tileProperties[String(localIndex)];
    this.state = {
      loaded: true,
      atlasFrames: [],
      pivots: {},
      animationFrames: [],
      animationFps: 0,
      observedFrames: [],
      playerBottom: this.testActorBody.bottom,
      floorTop: ground?.pixelY ?? 64,
      collisionEnabled: ground?.collides === true,
      tileset: {
        name: binding.name,
        firstgid: binding.firstgid,
        localIndexByName: { ...binding.localIndexByName },
        globalIndexByName: { ...binding.globalIndexByName },
        collisionLocalIndices: [...binding.collisionLocalIndices],
        terrainByLocalIndex: { ...binding.terrainByLocalIndex },
      },
      tileProperties: {
        collides: groundProperties?.collides === true,
        terrain: String(groundProperties?.terrain ?? ""),
        name: String(groundProperties?.name ?? ""),
      },
    };
    window.__ASSET_PREVIEW_TEST__ = () => this.readState();
  }

  private createGeneratedTilemapPreview(): void {
    const metadata = parseGeneratedTilesetMetadata(this.cache.json.get("generated-map-tileset-metadata"));
    if (!metadata) throw new Error("generated_tilemap_tileset_metadata_invalid");
    const generated = createGeneratedTilemap(this, "generated-map", metadata, "generated-map-image");
    const background = generated.layers.find(({ name }) => name === "background");
    const hidden = generated.layers.find(({ name }) => name === "hidden");
    const ground = generated.layers.find(({ name }) => name === "ground");
    const props = generated.layers.find(({ name }) => name === "props");
    if (!background || !hidden || !ground || !props) throw new Error("generated_tilemap_required_layer_missing");
    const floorTile = ground.layer.getTileAt(1, 4);
    const emptyTile = ground.layer.getTileAt(7, 4);
    const unselectedSolidTile = props.layer.getTileAt(7, 4);
    this.physics.world.setBounds(0, 0, generated.map.widthInPixels, generated.map.heightInPixels);
    const player = this.add.rectangle(24, 34, 10, 12, 0xffffff);
    this.physics.add.existing(player);
    this.testActorBody = player.body as Phaser.Physics.Arcade.Body;
    this.testActorBody.setSize(10, 12).setOffset(0, 0);
    this.physics.add.collider(player, ground.layer);
    const freePlayer = this.add.rectangle(120, 34, 10, 12, 0xf7768e);
    this.physics.add.existing(freePlayer);
    this.freeActorBody = freePlayer.body as Phaser.Physics.Arcade.Body;
    this.freeActorBody.setSize(10, 12).setOffset(0, 0);
    this.physics.add.collider(freePlayer, props.layer);

    this.state = {
      loaded: true,
      atlasFrames: [],
      pivots: {},
      animationFrames: [],
      animationFps: 0,
      observedFrames: [],
      playerBottom: this.testActorBody.bottom,
      floorTop: floorTile?.pixelY ?? 0,
      collisionEnabled: floorTile?.collides === true,
      tilemap: {
        width: generated.map.width,
        height: generated.map.height,
        tileSize: generated.map.tileWidth,
        firstgid: generated.tileset.firstgid,
        layerNames: generated.layers.map(({ name }) => name),
        layerVisibility: generated.layers.map(({ visible }) => visible),
        layerCollision: generated.layers.map(({ collides }) => collides),
        backgroundIndices: [0, 1, 2, 3].map((x) => background.layer.getTileAt(x, 0)?.index ?? null),
        floorTileIndex: floorTile?.index ?? -999,
        emptyTileIndex: emptyTile?.index ?? -1,
        unselectedSolidTileCollides: unselectedSolidTile?.collides === true,
        playerBottom: this.testActorBody.bottom,
        freePlayerBottom: this.freeActorBody.bottom,
      },
    };
    window.__ASSET_PREVIEW_TEST__ = () => this.readState();
  }

  private createPackedSpritesheetPreview(): void {
    const atlas = parseGeneratedSpritesheetAtlas(this.cache.json.get("packed-spritesheet-data"));
    if (!atlas) throw new Error("generated_spritesheet_atlas_invalid");
    const animation = this.cache.json.get("packed-animation") as { key: string; fps: number; frames: string[] };
    if (!animation || !/^[a-z][a-z0-9_-]{1,47}$/.test(animation.key) ||
        !Number.isInteger(animation.fps) || animation.fps < 1 || animation.fps > 60 ||
        !Array.isArray(animation.frames) || animation.frames.length < 1 ||
        animation.frames.some((name) => !atlas.frameNames.includes(name))) {
      throw new Error("generated_spritesheet_animation_invalid");
    }
    const texture = this.textures.get("packed-spritesheet");
    const atlasFrames = texture.getFrameNames();
    const pivots = Object.fromEntries(atlasFrames.map((name) => {
      const frame = texture.get(name);
      return [name, { custom: frame.customPivot, x: frame.pivotX, y: frame.pivotY }];
    }));
    this.anims.create({
      key: animation.key,
      frames: animation.frames.map((name) => ({ key: "packed-spritesheet", frame: name })),
      frameRate: animation.fps,
      repeat: -1,
    });

    const metadata = parseGeneratedTilesetMetadata(this.cache.json.get("generated-map-tileset-metadata"));
    if (!metadata) throw new Error("generated_tilemap_tileset_metadata_invalid");
    const generated = createGeneratedTilemap(this, "generated-map", metadata, "generated-map-image");
    const ground = generated.layers.find(({ name }) => name === "ground");
    const props = generated.layers.find(({ name }) => name === "props");
    if (!ground || !props) throw new Error("generated_tilemap_required_layer_missing");
    const floorTile = ground.layer.getTileAt(1, 4);
    const emptyTile = ground.layer.getTileAt(7, 4);
    const unselectedSolidTile = props.layer.getTileAt(7, 4);
    this.physics.world.setBounds(0, 0, generated.map.widthInPixels, generated.map.heightInPixels);
    this.actor = this.physics.add.sprite(24, 38, "packed-spritesheet", animation.frames[0]);
    this.actor.body?.setSize(10, 12).setOffset(3, 2);
    this.physics.add.collider(this.actor, ground.layer);
    this.actor.play(animation.key);
    const freeActor = this.add.rectangle(120, 34, 10, 12, 0xf7768e);
    this.physics.add.existing(freeActor);
    this.freeActorBody = freeActor.body as Phaser.Physics.Arcade.Body;
    this.freeActorBody.setSize(10, 12).setOffset(0, 0);
    this.physics.add.collider(freeActor, props.layer);
    this.state = {
      loaded: true,
      atlasFrames,
      pivots,
      animationFrames: [...animation.frames],
      animationFps: animation.fps,
      observedFrames: this.observedFrames,
      playerBottom: this.actor.body?.bottom ?? 0,
      floorTop: floorTile?.pixelY ?? 0,
      collisionEnabled: floorTile?.collides === true,
      atlasValid: true,
      atlasTextureSize: { width: atlas.width, height: atlas.height },
      tilemap: {
        width: generated.map.width,
        height: generated.map.height,
        tileSize: generated.map.tileWidth,
        firstgid: generated.tileset.firstgid,
        layerNames: generated.layers.map(({ name }) => name),
        layerVisibility: generated.layers.map(({ visible }) => visible),
        layerCollision: generated.layers.map(({ collides }) => collides),
        backgroundIndices: [],
        floorTileIndex: floorTile?.index ?? -999,
        emptyTileIndex: emptyTile?.index ?? -1,
        unselectedSolidTileCollides: unselectedSolidTile?.collides === true,
        playerBottom: this.actor.body?.bottom ?? 0,
        freePlayerBottom: this.freeActorBody.bottom,
      },
    };
    window.__ASSET_PREVIEW_TEST__ = () => this.readState();
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
