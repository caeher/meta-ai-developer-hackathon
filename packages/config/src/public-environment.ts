import { z } from "zod";

export const PublicEnvironmentSchema = z
  .object({
    APP_ORIGIN: z.url().optional(),
    NEXT_PUBLIC_APP_URL: z.url().optional(),
  })
  .strict();

export type PublicEnvironment = z.infer<typeof PublicEnvironmentSchema>;

export function parsePublicEnvironment(
  source: Record<string, string | undefined>,
): PublicEnvironment {
  const result = PublicEnvironmentSchema.safeParse({
    APP_ORIGIN: source.APP_ORIGIN,
    NEXT_PUBLIC_APP_URL: source.NEXT_PUBLIC_APP_URL,
  });

  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid application environment fields: ${fields.join(", ")}`);
  }

  return result.data;
}
