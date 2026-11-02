import { z } from "zod";

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

export const EditorProgressSchema = z.object({
  status: EditorRunStatusSchema,
  plan: z.array(z.string().min(1).max(240)).max(40),
  steps: z.array(EditorPlanStepSchema).max(100),
  changedFiles: z.array(z.string().min(1).max(256)).max(100),
  verification: EditorVerificationSchema,
});

export type EditorRunStatus = z.infer<typeof EditorRunStatusSchema>;
export type EditorStepStatus = z.infer<typeof EditorStepStatusSchema>;
export type EditorProgress = z.infer<typeof EditorProgressSchema>;
