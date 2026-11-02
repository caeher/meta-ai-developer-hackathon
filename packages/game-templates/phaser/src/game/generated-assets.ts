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

function isIntegerIn(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
