import { z } from "zod";

export const RunStatusSchema = z.enum([
  "queued",
  "planning",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
]);

export const EnqueueRunRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
  /** requestId of an already stored user message; linked to the run before it reaches the queue. */
  messageRequestId: z.string().trim().min(8).max(128).optional(),
  /**
   * @deprecated El consentimiento deriva de users.contributor_consent_at en el servidor;
   * se acepta por compatibilidad con clientes viejos y se ignora.
   */
  contributorConsent: z.literal(true).optional(),
}).strict();

/** Redis payload is deliberately limited to opaque IDs and the idempotency key. */
export const RunQueueJobSchema = z.object({
  runId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  generation: z.number().int().nonnegative(),
}).strict();

export const RunResponseSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  status: RunStatusSchema,
  errorCode: z.string().max(100).nullable(),
  cancelRequested: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type EnqueueRunRequest = z.infer<typeof EnqueueRunRequestSchema>;
export type RunQueueJob = z.infer<typeof RunQueueJobSchema>;
export type RunResponse = z.infer<typeof RunResponseSchema>;
