import { z } from "zod";
import { MetaPlanSchema } from "./meta";

const callId = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);
const safeHash = z.string().regex(/^[a-f0-9]{64}$/);

export const AgentRunEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.plan"),
    payload: z.object({
      plan: MetaPlanSchema,
      model: z.string().min(1).max(128),
      responseId: z.string().min(1).max(128),
      requestId: z.string().min(1).max(128).optional(),
      usage: z.object({ tokens: z.number().int().nonnegative(), images: z.literal(0) }).strict(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.skills_selected"),
    payload: z.object({ record: z.record(z.string(), z.unknown()) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.meta_request_started"),
    payload: z.object({ kind: z.enum(["plan", "code"]), requestKey: z.string().min(1).max(40), round: z.number().int().nonnegative() }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.meta_response_completed"),
    payload: z.object({
      kind: z.enum(["plan", "code"]),
      requestKey: z.string().min(1).max(40),
      responseId: z.string().min(1).max(128),
      requestId: z.string().min(1).max(128).optional(),
      model: z.string().min(1).max(128),
      usage: z.object({ tokens: z.number().int().nonnegative(), images: z.literal(0) }).strict(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.sandbox_ready"),
    payload: z.object({ state: z.literal("ready"), leaseExpiresAt: z.string().datetime().nullable() }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.preview_ready"),
    payload: z.object({ state: z.literal("ready") }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.tool_started"),
    payload: z.object({ callId, toolName: z.string().min(1).max(64), argsHash: safeHash }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.tool_completed"),
    payload: z.object({ callId, toolName: z.string().min(1).max(64), argsHash: safeHash, result: z.string().max(65_536) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.action"),
    payload: z.object({ callId, toolName: z.string().min(1).max(64), summary: z.string().min(1).max(240) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.verification"),
    payload: z.object({
      check: z.string().min(1).max(120),
      status: z.enum(["passed", "failed", "skipped"]),
      exitCode: z.number().int().min(-1).max(255).optional(),
      summary: z.string().min(1).max(1_000),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.input_rejected"),
    payload: z.object({ reason: z.enum(["sensitive_content", "missing_message"]) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.completed"),
    payload: z.object({ summary: z.string().max(600), verification: z.enum(["passed", "skipped"]) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("agent.failed"),
    payload: z.object({ errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/) }).strict(),
  }).strict(),
]);

export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;

const runStreamBase = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().datetime(),
});

const runStatuses = z.enum(["queued", "planning", "running", "verifying"]);

/** Public SSE envelope. Private worker payloads never cross this projection boundary. */
export const RunStreamEventSchema = z.discriminatedUnion("type", [
  runStreamBase.extend({ type: z.literal("run.cursor"), payload: z.object({}).strict() }).strict(),
  runStreamBase.extend({ type: z.literal("run.queued"), payload: z.object({ status: z.literal("queued") }).strict() }).strict(),
  runStreamBase.extend({ type: z.literal("run.status"), payload: z.object({ status: runStatuses }).strict() }).strict(),
  runStreamBase.extend({ type: z.literal("run.cancel_requested"), payload: z.object({}).strict() }).strict(),
  runStreamBase.extend({
    type: z.literal("plan.created"),
    payload: z.object({
      summary: z.string().min(1).max(600),
      objective: z.string().min(1).max(300),
      steps: z.array(z.object({ id: z.string().min(1).max(64), title: z.string().min(1).max(120) }).strict()).max(12),
    }).strict(),
  }).strict(),
  runStreamBase.extend({
    type: z.literal("step.started"),
    payload: z.object({ stepId: z.string().min(1).max(64), title: z.string().min(1).max(240) }).strict(),
  }).strict(),
  runStreamBase.extend({
    type: z.literal("step.completed"),
    payload: z.object({
      stepId: z.string().min(1).max(64),
      title: z.string().min(1).max(240),
      status: z.enum(["succeeded", "failed", "skipped"]),
    }).strict(),
  }).strict(),
  runStreamBase.extend({
    type: z.literal("file.changed"),
    payload: z.object({ path: z.string().min(1).max(256), bytesWritten: z.number().int().nonnegative().optional() }).strict(),
  }).strict(),
  runStreamBase.extend({
    type: z.literal("verification.result"),
    payload: z.object({
      check: z.string().min(1).max(120),
      status: z.enum(["passed", "failed", "skipped"]),
      exitCode: z.number().int().min(-1).max(255).optional(),
      summary: z.string().min(1).max(500),
    }).strict(),
  }).strict(),
  runStreamBase.extend({ type: z.literal("preview.ready"), payload: z.object({ state: z.literal("ready") }).strict() }).strict(),
  runStreamBase.extend({ type: z.literal("run.finished"), payload: z.object({ summary: z.string().max(600) }).strict() }).strict(),
  runStreamBase.extend({ type: z.literal("run.failed"), payload: z.object({ errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/) }).strict() }).strict(),
  runStreamBase.extend({ type: z.literal("run.cancelled"), payload: z.object({}).strict() }).strict(),
]);

export type RunStreamEvent = z.infer<typeof RunStreamEventSchema>;
