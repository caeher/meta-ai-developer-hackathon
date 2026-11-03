import { z } from "zod";

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const issueId = z.string().regex(/^\d{2}-[a-z][a-z0-9-]{0,47}$/);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const IssueFileStatusSchema = z.enum(["pending", "running", "completed", "failed"]);
export const SubagentStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);
// Flujo agentico por fases: inventario -> plan de sprites -> sprites -> plan de juego -> codigo -> verificacion.
export const AgenticPhaseSchema = z.enum(["inventory", "sprite-plan", "sprites", "game-plan", "code", "verification"]);
export type AgenticPhase = z.infer<typeof AgenticPhaseSchema>;
export const AgenticPhaseStatusSchema = z.enum(["pending", "running", "completed", "failed", "skipped"]);
export type AgenticPhaseStatus = z.infer<typeof AgenticPhaseStatusSchema>;
export const IssuePlanKindSchema = z.enum(["sprites", "game", "general"]);
export type IssuePlanKind = z.infer<typeof IssuePlanKindSchema>;
export const ToolCallStatusSchema = z.enum(["running", "succeeded", "failed"]);
export const ToolCallStateSchema = z.object({
  callId: z.string().min(1).max(80),
  toolName: z.string().min(1).max(64),
  title: z.string().min(1).max(240),
  status: ToolCallStatusSchema,
  phase: AgenticPhaseSchema.optional(),
  issueId: z.string().min(1).max(64).optional(),
  summary: z.string().min(1).max(600).optional(),
}).strict();
export type ToolCallState = z.infer<typeof ToolCallStateSchema>;
export function phaseForIssueKind(kind: IssuePlanKind, forExecution: boolean): AgenticPhase {
  if (kind === "sprites") return forExecution ? "sprites" : "sprite-plan";
  if (kind === "game") return forExecution ? "code" : "game-plan";
  return forExecution ? "code" : "game-plan";
}
export function issuePlanDirectory(kind: IssuePlanKind): string {
  if (kind === "sprites") return "docs/issues/sprites";
  if (kind === "game") return "docs/issues/game";
  return "docs/issues";
}

export const AgentIssueSchema = z.object({
  id: issueId,
  title: z.string().min(1).max(160),
  path: z.string().regex(/^docs\/issues\/(?:sprites\/|game\/)?\d{2}-[a-z][a-z0-9-]{0,47}\.md$/),
  kind: IssuePlanKindSchema.default("general"),
  status: IssueFileStatusSchema,
  dependsOn: z.array(issueId).max(11).default([]),
}).strict();
export type AgentIssue = z.infer<typeof AgentIssueSchema>;

export const SubagentStateSchema = z.object({
  issueId,
  title: z.string().min(1).max(160),
  status: SubagentStatusSchema,
  kind: IssuePlanKindSchema.default("general"),
  phase: AgenticPhaseSchema.optional(),
  summary: z.string().min(1).max(600).optional(),
}).strict();
export type SubagentState = z.infer<typeof SubagentStateSchema>;

// --- make_transparent ---
const MakeTransparentInputBase = z.object({
  sourceAssetId: z.string().uuid(),
  sourceFrameIndex: z.number().int().min(0).max(63).default(0),
  mode: z.enum(["corner-flood", "color-key", "alpha-cleanup"]).default("corner-flood"),
  color: hexColor.optional(),
  tolerance: z.number().int().min(0).max(100).default(16),
}).strict();
export const MakeTransparentInputSchema = MakeTransparentInputBase.superRefine((input, ctx) => {
  if (input.mode === "color-key" && !input.color) ctx.addIssue({ code: "custom", path: ["color"], message: "color is required for color-key mode." });
});
export const MakeTransparentInputJsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#", title: "MakeTransparentInput", type: "object", additionalProperties: false,
  required: ["sourceAssetId"],
  properties: {
    sourceAssetId: { type: "string", format: "uuid" },
    sourceFrameIndex: { type: "integer", minimum: 0, maximum: 63, default: 0 },
    mode: { type: "string", enum: ["corner-flood", "color-key", "alpha-cleanup"], default: "corner-flood" },
    color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    tolerance: { type: "integer", minimum: 0, maximum: 100, default: 16 },
  },
} as const;
export type MakeTransparentInput = z.infer<typeof MakeTransparentInputSchema>;

export const MakeTransparentResultSchema = z.object({
  assetId: z.string().uuid(),
  sourceAssetId: z.string().uuid(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string().regex(/^assets\/generated\/[0-9a-f-]{36}\.png$/),
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  removedPixels: z.number().int().nonnegative(),
  transparentPixels: z.literal(true),
  mode: z.enum(["corner-flood", "color-key", "alpha-cleanup"]),
  reviewStatus: z.literal("pending-in-live-preview"),
}).strict().superRefine((r, ctx) => {
  if (r.path !== `assets/generated/${r.assetId}.png` || r.assetId === r.sourceAssetId) ctx.addIssue({ code: "custom", path: ["path"], message: "Transparent assets need a new ID-derived path." });
});
export const MakeTransparentResultJsonSchema = z.toJSONSchema(MakeTransparentResultSchema, { target: "draft-7" });
export type MakeTransparentResult = z.infer<typeof MakeTransparentResultSchema>;

// --- create_issue_plan ---
const CreateIssuePlanIssueBase = z.object({
  slug,
  title: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(1000),
  tasks: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  dependsOn: z.array(slug).max(11).default([]),
  acceptance: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
}).strict();
const CreateIssuePlanInputBase = z.object({
  title: z.string().trim().min(1).max(120),
  kind: IssuePlanKindSchema.default("general"),
  issues: z.array(CreateIssuePlanIssueBase).min(1).max(12),
}).strict();
export const CreateIssuePlanInputSchema = CreateIssuePlanInputBase.superRefine((input, ctx) => {
  const slugs = new Set<string>();
  for (const [i, issue] of input.issues.entries()) {
    if (slugs.has(issue.slug)) ctx.addIssue({ code: "custom", path: ["issues", i, "slug"], message: "Issue slugs must be unique." });
    slugs.add(issue.slug);
  }
  for (const [i, issue] of input.issues.entries()) {
    for (const dep of issue.dependsOn) {
      if (dep === issue.slug || !slugs.has(dep)) ctx.addIssue({ code: "custom", path: ["issues", i, "dependsOn"], message: "Dependencies must reference another issue slug in the plan." });
    }
  }
});
export const CreateIssuePlanInputJsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#", title: "CreateIssuePlanInput", type: "object", additionalProperties: false,
  required: ["title", "issues"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    kind: { type: "string", enum: ["sprites", "game", "general"], default: "general" },
    issues: { type: "array", minItems: 1, maxItems: 12, items: {
      type: "object", additionalProperties: false, required: ["slug", "title", "objective", "tasks"],
      properties: {
        slug: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" },
        title: { type: "string", minLength: 1, maxLength: 160 },
        objective: { type: "string", minLength: 1, maxLength: 1000 },
        tasks: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 300 } },
        dependsOn: { type: "array", maxItems: 11, items: { type: "string" }, default: [] },
        acceptance: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 300 }, default: [] },
      },
    } },
  },
} as const;
export type CreateIssuePlanInput = z.infer<typeof CreateIssuePlanInputSchema>;
export type CreateIssuePlanIssue = z.infer<typeof CreateIssuePlanIssueBase>;

export const CreateIssuePlanResultSchema = z.object({
  planId: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/),
  title: z.string().min(1).max(120),
  kind: IssuePlanKindSchema.default("general"),
  indexPath: z.enum(["docs/issues/INDEX.md", "docs/issues/sprites/INDEX.md", "docs/issues/game/INDEX.md"]),
  issues: z.array(AgentIssueSchema).min(1).max(12),
}).strict();
export const CreateIssuePlanResultJsonSchema = z.toJSONSchema(CreateIssuePlanResultSchema, { target: "draft-7" });
export type CreateIssuePlanResult = z.infer<typeof CreateIssuePlanResultSchema>;

// --- run_issue_agents ---
const RunIssueAgentsIssueBase = z.object({
  issueId,
  title: z.string().trim().min(1).max(160),
  instructions: z.string().trim().min(1).max(4000),
  dependsOn: z.array(issueId).max(7).default([]),
}).strict();
const RunIssueAgentsInputBase = z.object({
  kind: IssuePlanKindSchema.default("general"),
  issues: z.array(RunIssueAgentsIssueBase).min(1).max(8),
}).strict();
export const RunIssueAgentsInputSchema = RunIssueAgentsInputBase.superRefine((input, ctx) => {
  const ids = new Set<string>();
  for (const [i, issue] of input.issues.entries()) {
    if (ids.has(issue.issueId)) ctx.addIssue({ code: "custom", path: ["issues", i, "issueId"], message: "Issue IDs must be unique." });
    ids.add(issue.issueId);
  }
  for (const [i, issue] of input.issues.entries()) {
    for (const dep of issue.dependsOn) if (dep === issue.issueId || !ids.has(dep)) ctx.addIssue({ code: "custom", path: ["issues", i, "dependsOn"], message: "Dependencies must reference another issue in the batch." });
  }
});
export const RunIssueAgentsInputJsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#", title: "RunIssueAgentsInput", type: "object", additionalProperties: false,
  required: ["issues"],
  properties: {
    kind: { type: "string", enum: ["sprites", "game", "general"], default: "general" },
    issues: { type: "array", minItems: 1, maxItems: 8, items: {
      type: "object", additionalProperties: false, required: ["issueId", "title", "instructions"],
      properties: {
        issueId: { type: "string", pattern: "^\\d{2}-[a-z][a-z0-9-]{0,47}$" },
        title: { type: "string", minLength: 1, maxLength: 160 },
        instructions: { type: "string", minLength: 1, maxLength: 4000 },
        dependsOn: { type: "array", maxItems: 7, items: { type: "string" }, default: [] },
      },
    } },
  },
} as const;
export type RunIssueAgentsInput = z.infer<typeof RunIssueAgentsInputSchema>;

export const RunIssueAgentsResultSchema = z.object({
  kind: IssuePlanKindSchema.default("general"),
  results: z.array(z.object({
    issueId,
    title: z.string().min(1).max(160),
    status: z.enum(["succeeded", "failed"]),
    summary: z.string().min(1).max(600),
    toolCalls: z.number().int().nonnegative().max(100),
  }).strict()).min(1).max(8),
}).strict();
export const RunIssueAgentsResultJsonSchema = z.toJSONSchema(RunIssueAgentsResultSchema, { target: "draft-7" });
export type RunIssueAgentsResult = z.infer<typeof RunIssueAgentsResultSchema>;