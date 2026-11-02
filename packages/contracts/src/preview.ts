import { z } from "zod";

export const PREVIEW_GRANT_AUDIENCE = "meta-game-preview-gateway";
export const PREVIEW_GRANT_ISSUER = "meta-game-web";
export const PREVIEW_GRANT_TTL_SECONDS = 60;
export const PREVIEW_SESSION_COOKIE = "__Host-preview_session";
export const PREVIEW_DEFAULT_SESSION_TTL_SECONDS = 900;
export const PREVIEW_EGRESS_PROXY_PORT = 8080;

const userId = z.string().regex(/^user_[A-Za-z0-9]{1,240}$/);
const uuid = z.string().uuid();

export const PreviewGrantClaimsSchema = z.object({
  iss: z.literal(PREVIEW_GRANT_ISSUER),
  sub: userId,
  userId: userId,
  projectId: uuid,
  aud: z.literal(PREVIEW_GRANT_AUDIENCE),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  jti: uuid,
  epoch: z.number().int().nonnegative().safe(),
}).strict().refine((claims) => claims.sub === claims.userId && claims.exp > claims.iat, {
  message: "Invalid preview grant lifetime or subject",
});

export const PreviewSessionSchema = z.object({
  userId: userId,
  projectId: uuid,
  epoch: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().positive(),
}).strict();

export const PreviewExchangeInputSchema = z.object({ grant: z.string().min(1).max(8192) }).strict();

export type PreviewGrantClaims = z.infer<typeof PreviewGrantClaimsSchema>;
export type PreviewSession = z.infer<typeof PreviewSessionSchema>;
