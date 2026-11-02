import { z } from "zod";

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("web"),
  })
  .strict();

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().regex(/^[A-Z0-9_]{1,64}$/),
        message: z.string().trim().min(1).max(200),
        requestId: z.string().trim().min(1).max(128).optional(),
      })
      .strict(),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
