import type Phaser from "phaser";

export type GeneratedAnimation = Readonly<{
  key: string;
  frameNames: readonly string[];
  frameRate: number;
  repeat: number;
  yoyo: boolean;
  delayMs: number;
  repeatDelayMs: number;
}>;

export type GeneratedAnimationManifest = Readonly<{
  schemaVersion: 1;
  animationManifestAssetId: string;
  atlasAssetId: string;
  atlasSha256: string;
  animations: readonly GeneratedAnimation[];
}>;

export type GeneratedAnimationAtlas = Readonly<{
  textureKey: string;
  assetId: string;
  sha256: string;
}>;

const registrations = new WeakMap<Phaser.Animations.AnimationManager, Map<string, string>>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/;
const keyPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const framePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Register validated, explicitly named atlas frames without installing scene listeners. */
export function registerGeneratedAnimations(
  scene: Phaser.Scene,
  atlas: GeneratedAnimationAtlas,
  manifestValue: unknown,
): readonly string[] {
  const manifest = parseManifest(manifestValue);
  if (!manifest) throw new Error("generated_animation_manifest_invalid");
  if (!uuidPattern.test(atlas.assetId) || manifest.atlasAssetId !== atlas.assetId ||
      !sha256Pattern.test(atlas.sha256) || manifest.atlasSha256 !== atlas.sha256) {
    throw new Error("generated_animation_atlas_mismatch");
  }
  if (!atlas.textureKey || atlas.textureKey.length > 128 || !scene.textures.exists(atlas.textureKey)) {
    throw new Error("generated_animation_texture_missing");
  }
  const availableFrames = new Set(scene.textures.get(atlas.textureKey).getFrameNames());
  for (const animation of manifest.animations) {
    const missing = animation.frameNames.find((name) => !availableFrames.has(name));
    if (missing) throw new Error("generated_animation_frame_missing");
  }

  const manager = scene.anims;
  const registered = registrations.get(manager) ?? new Map<string, string>();
  registrations.set(manager, registered);
  const pending: GeneratedAnimation[] = [];
  for (const animation of manifest.animations) {
    const signature = animationSignature(atlas.textureKey, animation);
    if (manager.exists(animation.key)) {
      if (registered.get(animation.key) === signature) continue;
      throw new Error(`generated_animation_key_conflict:${animation.key}`);
    }
    pending.push(animation);
  }
  for (const animation of pending) {
    const signature = animationSignature(atlas.textureKey, animation);
    const frames: Phaser.Types.Animations.AnimationFrame[] = animation.frameNames.map((frame) => ({
      key: atlas.textureKey,
      frame,
    }));
    const created = manager.create({
      key: animation.key,
      frames,
      frameRate: animation.frameRate,
      repeat: animation.repeat,
      yoyo: animation.yoyo,
      delay: animation.delayMs,
      repeatDelay: animation.repeatDelayMs,
    });
    if (!created) throw new Error(`generated_animation_key_conflict:${animation.key}`);
    registered.set(animation.key, signature);
  }
  return manifest.animations.map(({ key }) => key);
}

/** Return reproducible nominal timing and the declared frame order without consulting a running clock. */
export function getGeneratedAnimationTiming(animationValue: unknown): Readonly<{
  frameDurationMs: number;
  frameNames: readonly string[];
  repeat: number;
  yoyo: boolean;
  totalDurationMs: number | null;
}> {
  const animation = parseAnimation(animationValue);
  if (!animation) throw new Error("generated_animation_definition_invalid");
  const frameDurationMs = 1_000 / animation.frameRate;
  const totalDurationMs = animation.repeat === -1
    ? null
    : animation.delayMs + frameDurationMs * animation.frameNames.length * (animation.repeat + 1) +
      animation.repeatDelayMs * animation.repeat +
      (animation.yoyo ? frameDurationMs * Math.max(0, animation.frameNames.length - 1) * animation.repeat : 0);
  return {
    frameDurationMs,
    frameNames: [...animation.frameNames],
    repeat: animation.repeat,
    yoyo: animation.yoyo,
    totalDurationMs,
  };
}

export function playGeneratedAnimation(sprite: Phaser.GameObjects.Sprite, key: string): void {
  if (!keyPattern.test(key) || !sprite.anims.animationManager.exists(key)) {
    throw new Error("generated_animation_not_registered");
  }
  sprite.play(key);
}

function parseManifest(value: unknown): GeneratedAnimationManifest | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.animationManifestAssetId !== "string" ||
      !uuidPattern.test(value.animationManifestAssetId) || typeof value.atlasAssetId !== "string" || !uuidPattern.test(value.atlasAssetId) ||
      typeof value.atlasSha256 !== "string" || !sha256Pattern.test(value.atlasSha256) ||
      !Array.isArray(value.animations) || value.animations.length < 1 || value.animations.length > 32) return undefined;
  const animations: GeneratedAnimation[] = [];
  const keys = new Set<string>();
  for (const item of value.animations) {
    const animation = parseAnimation(item);
    if (!animation || keys.has(animation.key)) return undefined;
    keys.add(animation.key);
    animations.push(animation);
  }
  return {
    schemaVersion: 1,
    animationManifestAssetId: value.animationManifestAssetId,
    atlasAssetId: value.atlasAssetId,
    atlasSha256: value.atlasSha256,
    animations,
  };
}

function parseAnimation(value: unknown): GeneratedAnimation | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || !keyPattern.test(value.key) ||
      !Array.isArray(value.frameNames) || value.frameNames.length < 1 || value.frameNames.length > 256 ||
      !value.frameNames.every((frame) => typeof frame === "string" && framePattern.test(frame)) ||
      new Set(value.frameNames).size !== value.frameNames.length ||
      typeof value.frameRate !== "number" || !Number.isFinite(value.frameRate) || value.frameRate < 1 || value.frameRate > 60 ||
      typeof value.repeat !== "number" || !Number.isInteger(value.repeat) || value.repeat < -1 || value.repeat > 1_000 || typeof value.yoyo !== "boolean" ||
      !isBoundedInteger(value.delayMs, 60_000) || !isBoundedInteger(value.repeatDelayMs, 60_000)) return undefined;
  return {
    key: value.key,
    frameNames: [...value.frameNames] as string[],
    frameRate: value.frameRate,
    repeat: value.repeat,
    yoyo: value.yoyo,
    delayMs: value.delayMs,
    repeatDelayMs: value.repeatDelayMs,
  };
}

function animationSignature(textureKey: string, animation: GeneratedAnimation): string {
  return JSON.stringify({ textureKey, ...animation });
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
