import { z } from "zod";
import { AssetToolCardSchema } from "./asset-tools";
import { AgentIssueSchema, SubagentStateSchema, AgenticPhaseSchema, ToolCallStateSchema } from "./agent-orchestration";

export const EditorRunStatusSchema = z.enum([
  "queued",
  "planning",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);

export const EditorStepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const EditorVerificationSchema = z.object({
  status: z.enum(["pending", "running", "passed", "failed", "skipped"]),
  summary: z.string().max(500).optional(),
});

export const EditorPlanStepSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  status: EditorStepStatusSchema,
});

export const EditorPhaseStateSchema = z.object({
  phase: AgenticPhaseSchema,
  status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  summary: z.string().min(1).max(600).optional(),
}).strict();
export type EditorPhaseState = z.infer<typeof EditorPhaseStateSchema>;
export const AGENTIC_PHASES = ["inventory", "sprite-plan", "sprites", "game-plan", "code", "verification"] as const;
export const EditorProgressSchema = z.object({
  status: EditorRunStatusSchema,
  plan: z.array(z.string().min(1).max(240)).max(40),
  steps: z.array(EditorPlanStepSchema).max(100),
  changedFiles: z.array(z.string().min(1).max(256)).max(100),
  assetCards: z.array(AssetToolCardSchema).max(100).default([]),
  issues: z.array(AgentIssueSchema).max(24).default([]),
  subagents: z.array(SubagentStateSchema).max(24).default([]),
  phases: z.array(EditorPhaseStateSchema).max(6).default([]),
  toolCalls: z.array(ToolCallStateSchema).max(100).default([]),
  verification: EditorVerificationSchema,
});

export type EditorRunStatus = z.infer<typeof EditorRunStatusSchema>;
export type EditorStepStatus = z.infer<typeof EditorStepStatusSchema>;
export type EditorProgress = z.infer<typeof EditorProgressSchema>;
