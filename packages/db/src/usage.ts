import { z } from "zod";
import { UsageLimitExceededError } from "./identity";

export const RunQuotaPolicySchema = z.object({
  maxConcurrentJobs: z.number().int().min(1).max(100),
  runMaxTokens: z.number().int().min(1).max(2_000_000),
  dailyTokenLimit: z.number().int().min(1).max(20_000_000),
  dailyImageLimit: z.number().int().min(1).max(100_000),
});

export type RunQuotaPolicy = z.infer<typeof RunQuotaPolicySchema>;

export function utcDayStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export function assertRunQuotaAvailable(input: {
  activeRuns: number;
  heldTokens: number;
  heldImages: number;
  consumedTokensToday: number;
  consumedImagesToday: number;
  reserveTokens: number;
  reserveImages: number;
  policy: RunQuotaPolicy;
}): void {
  const policy = RunQuotaPolicySchema.parse(input.policy);
  if (input.activeRuns >= policy.maxConcurrentJobs) throw new UsageLimitExceededError("concurrency");
  if (input.consumedTokensToday + input.heldTokens + input.reserveTokens > policy.dailyTokenLimit) {
    throw new UsageLimitExceededError("tokens");
  }
  if (input.consumedImagesToday + input.heldImages + input.reserveImages > policy.dailyImageLimit) {
    throw new UsageLimitExceededError("images");
  }
}

export function runChargeIdempotencyKey(runId: string): string {
  return `run:${runId}:charge`;
}
