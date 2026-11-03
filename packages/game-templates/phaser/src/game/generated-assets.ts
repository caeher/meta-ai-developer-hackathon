export type GeneratedRuntimeAsset = Readonly<{
  assetId: string;
  key: string;
  path: string;
  assetType: "sprite" | "background" | "tileset" | "ui";
  frameColumns: number;
  frameRows: number;
  frameWidth: number;
  frameHeight: number;
}>;

export type ParsedGeneratedSpritesheetAtlas = Readonly<{
  image: string;
  width: number;
  height: number;
  sha256: string;
  frameNames: readonly string[];
  frames: Readonly<Record<string, Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    pivotX: number;
    pivotY: number;
  }>>>;
}>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const assetTypes = new Set(["sprite", "background", "tileset", "ui"]);

export function parseGeneratedAssetManifest(value: unknown): GeneratedRuntimeAsset[] | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.assets) || value.assets.length > 128) return undefined;
  const ids = new Set<string>();
  const assets: GeneratedRuntimeAsset[] = [];
  for (const candidate of value.assets) {
    if (!isRecord(candidate) || typeof candidate.assetId !== "string" || !uuidPattern.test(candidate.assetId) ||
        candidate.key !== `generated-${candidate.assetId}` || candidate.path !== `assets/generated/${candidate.assetId}.png` ||
        typeof candidate.assetType !== "string" || !assetTypes.has(candidate.assetType) ||
        !isIntegerIn(candidate.frameColumns, 1, 8) || !isIntegerIn(candidate.frameRows, 1, 8) ||
        !isIntegerIn(candidate.frameWidth, 1, 2_048) || !isIntegerIn(candidate.frameHeight, 1, 2_048) || ids.has(candidate.assetId)) {
      return undefined;
    }
    ids.add(candidate.assetId);
    assets.push({
      assetId: candidate.assetId,
      key: candidate.key,
      path: candidate.path,
      assetType: candidate.assetType as GeneratedRuntimeAsset["assetType"],
      frameColumns: candidate.frameColumns,
      frameRows: candidate.frameRows,
      frameWidth: candidate.frameWidth,
      frameHeight: candidate.frameHeight,
    });
  }
  return assets;
}

export function parseGeneratedSpritesheetAtlas(value: unknown): ParsedGeneratedSpritesheetAtlas | undefined {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.frames)) return undefined;
  const meta = value.meta;
  const size = isRecord(meta.size) ? meta.size : undefined;
  if (meta.schemaVersion !== 1 || meta.engine !== "phaser-3.90.0" || meta.atlasFormat !== "phaser-json-hash" ||
      typeof meta.image !== "string" || !new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.png$").test(meta.image) ||
      !size || !isIntegerIn(size.w, 1, 4_096) || !isIntegerIn(size.h, 1, 4_096) ||
      typeof meta.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(meta.sha256) ||
      !Array.isArray(meta.provenance) || meta.provenance.length < 1 || meta.provenance.length > 256) return undefined;

  const entries = Object.entries(value.frames);
  if (entries.length !== meta.provenance.length || entries.length > 256) return undefined;
  const frames: Record<string, { x: number; y: number; width: number; height: number; pivotX: number; pivotY: number }> = {};
  const provenanceByName = new Map<string, Record<string, unknown>>();
  for (const item of meta.provenance) {
    if (!isRecord(item) || typeof item.frameName !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.frameName) ||
        typeof item.sourceAssetId !== "string" || !uuidPattern.test(item.sourceAssetId) ||
        !isIntegerIn(item.sourceFrameIndex, 0, 63) ||
        typeof item.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sourceSha256) ||
        provenanceByName.has(item.frameName)) return undefined;
    provenanceByName.set(item.frameName, item);
  }
  for (const [name, candidate] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || !isRecord(candidate) || !isRecord(candidate.frame) ||
        !isRecord(candidate.pivot) || !isRecord(candidate.spriteSourceSize) || !isRecord(candidate.sourceSize) ||
        candidate.rotated !== false || candidate.trimmed !== false || !provenanceByName.has(name)) return undefined;
    const rect = candidate.frame;
    const spriteSourceSize = candidate.spriteSourceSize;
    const sourceSize = candidate.sourceSize;
    if (!isIntegerIn(rect.x, 0, 4_095) || !isIntegerIn(rect.y, 0, 4_095) ||
        !isIntegerIn(rect.w, 1, 2_048) || !isIntegerIn(rect.h, 1, 2_048) ||
        (rect.x as number) + (rect.w as number) > (size.w as number) ||
        (rect.y as number) + (rect.h as number) > (size.h as number) ||
        spriteSourceSize.x !== 0 || spriteSourceSize.y !== 0 || spriteSourceSize.w !== rect.w || spriteSourceSize.h !== rect.h ||
        sourceSize.w !== rect.w || sourceSize.h !== rect.h ||
        typeof candidate.pivot.x !== "number" || candidate.pivot.x < 0 || candidate.pivot.x > 1 ||
        typeof candidate.pivot.y !== "number" || candidate.pivot.y < 0 || candidate.pivot.y > 1) return undefined;
    frames[name] = {
      x: rect.x as number,
      y: rect.y as number,
      width: rect.w as number,
      height: rect.h as number,
      pivotX: candidate.pivot.x,
      pivotY: candidate.pivot.y,
    };
  }
  const rects = Object.values(frames);
  for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
    const left = rects[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
      const right = rects[rightIndex]!;
      if (left.x < right.x + right.width && left.x + left.width > right.x &&
          left.y < right.y + right.height && left.y + left.height > right.y) return undefined;
    }
  }
  return {
    image: meta.image,
    width: size.w,
    height: size.h,
    sha256: meta.sha256,
    frameNames: entries.map(([name]) => name),
    frames,
  };
}

function isIntegerIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
