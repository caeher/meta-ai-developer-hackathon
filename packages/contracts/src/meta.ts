import { z } from "zod";

const expectedFilePath = z.string().min(1).max(512).refine((value) => {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." &&
    ![...part].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
}, "Expected files must stay within the workspace");

export const MetaPlanSchema = z
  .object({
    summary: z.string().trim().min(1).max(600),
    objective: z.string().trim().min(1).max(300),
    steps: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
            title: z.string().trim().min(1).max(120),
            description: z.string().trim().min(1).max(400),
            expectedFiles: z.array(expectedFilePath).max(24),
            verifications: z.array(z.string().trim().min(1).max(180)).min(1).max(6),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .superRefine((plan, context) => {
    const ids = new Set<string>();
    for (const [index, step] of plan.steps.entries()) {
      if (ids.has(step.id)) {
        context.addIssue({ code: "custom", path: ["steps", index, "id"], message: "Step IDs must be unique." });
      }
      ids.add(step.id);
    }
  });

export const MetaUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((usage) => usage.totalTokens >= usage.inputTokens + usage.outputTokens, {
    message: "totalTokens must cover inputTokens and outputTokens.",
    path: ["totalTokens"],
  });

export const MetaErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "rate_limited",
  "provider_error",
  "http_error",
  "timeout",
  "cancelled",
  "network_error",
  "invalid_request",
  "invalid_response",
  "incomplete_response",
  "model_unavailable",
  "invalid_tool_arguments",
  "invalid_image",
]);

export const MetaErrorDetailsSchema = z
  .object({
    code: MetaErrorCodeSchema,
    status: z.number().int().min(100).max(599).optional(),
    requestId: z.string().min(1).max(128).optional(),
    retryAfterMs: z.number().int().nonnegative().max(120_000).optional(),
    ambiguous: z.boolean(),
  })
  .strict();

export const MetaConversationItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      role: z.enum(["user", "assistant", "developer"]),
      text: z.string().min(1).max(100_000),
      phase: z.literal("commentary").optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_call"),
      callId: z.string().min(1).max(64),
      name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/),
      arguments: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool_result"),
      callId: z.string().min(1).max(64),
      output: z.string().max(65_536),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reasoning_replay"),
      encryptedContent: z.string().min(1).max(120_000),
    })
    .strict(),
]);

export const MetaPlanResultSchema = z
  .object({
    plan: MetaPlanSchema,
    model: z.string().min(1).max(128),
    responseId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128).optional(),
    usage: MetaUsageSchema.optional(),
  })
  .strict();

export const MetaCodeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), delta: z.string().min(1).max(1_000_000) }).strict(),
  z
    .object({
      type: z.literal("tool_call"),
      callId: z.string().min(1).max(64),
      name: z.string().min(1).max(64),
      arguments: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("completed"),
      responseId: z.string().min(1).max(128),
      model: z.string().min(1).max(128),
      replay: z.array(MetaConversationItemSchema).max(128),
      requestId: z.string().min(1).max(128).optional(),
      usage: MetaUsageSchema.optional(),
    })
    .strict(),
]);

export const MetaImageResultSchema = z
  .object({
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array)
      .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 20 * 1024 * 1024),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().min(1).max(8_192),
    height: z.number().int().min(1).max(8_192),
    model: z.string().min(1).max(128),
    responseId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128).optional(),
    usage: MetaUsageSchema.optional(),
  })
  .strict()
  .refine((image) => image.width * image.height <= 40_000_000, {
    message: "Image dimensions exceed the pixel limit.",
    path: ["width"],
  });

export type MetaPlan = z.infer<typeof MetaPlanSchema>;
export type MetaUsage = z.infer<typeof MetaUsageSchema>;
export type MetaErrorCode = z.infer<typeof MetaErrorCodeSchema>;
export type MetaErrorDetails = z.infer<typeof MetaErrorDetailsSchema>;
export type MetaConversationItem = z.infer<typeof MetaConversationItemSchema>;
export type MetaPlanResult = z.infer<typeof MetaPlanResultSchema>;
export type MetaCodeEvent = z.infer<typeof MetaCodeEventSchema>;
export type MetaImageResult = z.infer<typeof MetaImageResultSchema>;
