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
