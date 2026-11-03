import { z } from "zod";

export const ASSET_INSPECTION_MAX_REPORT_BYTES = 24_000;
export const ASSET_INSPECTION_MAX_FINDINGS = 64;
export const ASSET_INSPECTION_MAX_JSON_BYTES = 1_048_576;
export const ASSET_INSPECTION_MAX_ENTRIES = 4_096;

const assetWorkspacePathPattern = "^public/assets/(?:generated|atlases|tilesets|tilemaps|animations)/(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}/)*[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}\\.(?:png|jpe?g|webp|gif|json)$";

export const AssetInspectionKindSchema = z.enum([
  "auto",
  "image",
  "atlas",
  "tileset",
  "tilemap",
  "animation",
  "manifest",
]);

export const AssetInspectionCheckSchema = z.enum([
  "decode",
  "dimensions",
  "alpha",
  "frame-grid",
  "atlas-references",
  "tileset-grid",
  "tilemap-bounds",
  "animation-frame-names",
  "phaser-runtime",
]);

const InspectAssetInputBaseSchema = z.object({
  assetId: z.string().uuid().optional(),
  workspacePath: z.string().min(1).max(300).regex(new RegExp(assetWorkspacePathPattern)).optional(),
  kind: AssetInspectionKindSchema,
  checks: z.array(AssetInspectionCheckSchema).min(1).max(9),
}).strict();

export const InspectAssetInputSchema = InspectAssetInputBaseSchema.superRefine((input, context) => {
  if (Number(input.assetId !== undefined) + Number(input.workspacePath !== undefined) !== 1) {
    context.addIssue({ code: "custom", message: "Provide exactly one assetId or workspacePath." });
  }
  if (new Set(input.checks).size !== input.checks.length) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Checks must be unique." });
  }
});

export const AssetInspectionFindingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  code: z.string().regex(/^[a-z0-9_]{1,80}$/),
  message: z.string().max(500),
  path: z.string().max(512).optional(),
}).strict();

export const InspectAssetResultSchema = z.object({
  status: z.enum(["valid", "invalid", "needs_review"]),
  kind: z.enum(["image", "atlas", "tileset", "tilemap", "animation", "manifest"]),
  assetId: z.string().uuid().optional(),
  path: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  dimensions: z.object({
    width: z.number().int().min(1).max(4_096),
    height: z.number().int().min(1).max(4_096),
  }).strict().optional(),
  frameCount: z.number().int().min(0).max(ASSET_INSPECTION_MAX_ENTRIES).optional(),
  findings: z.array(AssetInspectionFindingSchema).max(ASSET_INSPECTION_MAX_FINDINGS),
}).strict();

const inputJsonSchema = z.toJSONSchema(InspectAssetInputBaseSchema, { target: "draft-7" });
const inputProperties = inputJsonSchema.properties as Record<string, Record<string, unknown>>;

/** Draft-7 contract sent to the provider, including the source exclusivity constraint. */
export const InspectAssetInputJsonSchema = {
  ...inputJsonSchema,
  properties: {
    ...inputProperties,
    checks: { ...inputProperties.checks, uniqueItems: true },
  },
  oneOf: [
    { required: ["assetId"], not: { required: ["workspacePath"] } },
    { required: ["workspacePath"], not: { required: ["assetId"] } },
  ],
} as const;

export const InspectAssetResultJsonSchema = z.toJSONSchema(InspectAssetResultSchema, { target: "draft-7" });

export type InspectAssetInput = z.infer<typeof InspectAssetInputSchema>;
export type AssetInspectionKind = Exclude<z.infer<typeof AssetInspectionKindSchema>, "auto">;
export type AssetInspectionCheck = z.infer<typeof AssetInspectionCheckSchema>;
export type AssetInspectionFinding = z.infer<typeof AssetInspectionFindingSchema>;
export type InspectAssetResult = z.infer<typeof InspectAssetResultSchema>;
