import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SESSION_COOKIE = "forja_session";
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;

export const emailSchema = z.string().trim().toLowerCase().email().max(320);
export const passwordSchema = z.string().min(12).max(128).refine((value) => /\S/.test(value), "invalid_password");
export const SESSION_COOKIE_NAME = SESSION_COOKIE;

export function normalizeEmail(value: unknown): string {
  return emailSchema.parse(value);
}

export function createUserId(): string {
  return `user_${randomUUID().replaceAll("-", "")}`;
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashRateLimitKey(value: string, source: NodeJS.ProcessEnv = process.env): string {
  const secret = source.AUTH_SECRET;
  if (source.NODE_ENV === "production" && (!secret || secret.length < 32 || /placeholder|replace-me|change-me/i.test(secret))) {
    throw new Error("AUTH_SECRET must be a generated value of at least 32 characters in production");
  }
  const key = secret && !/placeholder|replace-me|change-me/i.test(secret) ? secret : "development-only-auth-rate-limit-key";
  return createHmac("sha256", key).update(`auth:${value}`).digest("hex");
}

export function tokenHashMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function hashPassword(password: string): Promise<string> {
  const parsed = passwordSchema.parse(password);
  const salt = randomBytes(16);
  const derived = await deriveScrypt(parsed, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nText, rText, pText, saltText, keyText, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || !nText || !rText || !pText || !saltText || !keyText || extra !== undefined) {
    return false;
  }
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(keyText, "base64url");
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P || salt.length !== 16 || expected.length !== 64) {
    return false;
  }
  const actual = await deriveScrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return timingSafeEqual(actual, expected);
}

function deriveScrypt(password: string, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

export type SessionRecord = Readonly<{
  tokenHash: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}>;

export interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(tokenHash: string): Promise<SessionRecord | null>;
  extend(tokenHash: string, now: Date, expiresAt: Date): Promise<void>;
  revoke(tokenHash: string, now: Date): Promise<void>;
  revokeAll(userId: string, now: Date): Promise<void>;
}

export function createSessionManager(
  store: SessionStore,
  options: { slidingTtlMs?: number; absoluteTtlMs?: number } = {},
) {
  const slidingTtlMs = options.slidingTtlMs ?? sessionTtlMs();
  const absoluteTtlMs = options.absoluteTtlMs ?? absoluteSessionTtlMs();

  return {
    async create(userId: string, previousToken?: string, now = new Date()) {
      if (previousToken) await store.revoke(hashToken(previousToken), now);
      const token = createOpaqueToken();
      const absoluteExpiresAt = new Date(now.getTime() + absoluteTtlMs);
      const expiresAt = new Date(Math.min(now.getTime() + slidingTtlMs, absoluteExpiresAt.getTime()));
      await store.create({
        tokenHash: hashToken(token),
        userId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        absoluteExpiresAt,
        revokedAt: null,
      });
      return { token, expiresAt, absoluteExpiresAt };
    },

    async resolve(token: string | null | undefined, now = new Date()): Promise<{ userId: string } | null> {
      if (!token || token.length > 128) return null;
      const tokenHash = hashToken(token);
      const session = await store.get(tokenHash);
      if (!session || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now) return null;
      if (session.expiresAt.getTime() - now.getTime() <= slidingTtlMs / 2) {
        const expiresAt = new Date(Math.min(now.getTime() + slidingTtlMs, session.absoluteExpiresAt.getTime()));
        await store.extend(tokenHash, now, expiresAt);
      }
      return { userId: session.userId };
    },

    async revoke(token: string | null | undefined, now = new Date()) {
      if (token && token.length <= 128) await store.revoke(hashToken(token), now);
    },

    revokeAll(userId: string, now = new Date()) {
      return store.revokeAll(userId, now);
    },
  };
}

export type AuthRateLimitState = Readonly<{
  failures: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
}>;

export function nextRateLimitState(
  current: AuthRateLimitState | null,
  now = new Date(),
  windowMs = RATE_WINDOW_MS,
): AuthRateLimitState {
  const activeWindow = current && now.getTime() - current.windowStartedAt.getTime() < windowMs;
  const failures = (activeWindow ? current.failures : 0) + 1;
  const duration = progressiveLockDuration(failures);
  return {
    failures,
    windowStartedAt: activeWindow ? current.windowStartedAt : now,
    lockedUntil: duration === 0 ? null : new Date(now.getTime() + duration),
  };
}

export function progressiveLockDuration(failures: number): number {
  if (failures < 5) return 0;
  if (failures < 8) return 60 * 1000;
  if (failures < 10) return 5 * 60 * 1000;
  return 30 * 60 * 1000;
}

export function isRateLimited(state: AuthRateLimitState | null, now = new Date()): boolean {
  return Boolean(state?.lockedUntil && state.lockedUntil > now);
}

export function sessionTtlMs(source: NodeJS.ProcessEnv = process.env): number {
  return boundedTtl(source.SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_MS, 60, 30 * 24 * 60 * 60) * 1000;
}

export function absoluteSessionTtlMs(source: NodeJS.ProcessEnv = process.env): number {
  return boundedTtl(source.SESSION_ABSOLUTE_TTL_SECONDS, DEFAULT_ABSOLUTE_TTL_MS, 60, 90 * 24 * 60 * 60) * 1000;
}

function boundedTtl(value: string | undefined, fallbackMs: number, minimumSeconds: number, maximumSeconds: number): number {
  if (value === undefined) return fallbackMs / 1000;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimumSeconds || parsed > maximumSeconds) {
    throw new Error("Invalid authentication session TTL configuration");
  }
  return parsed;
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    "Priority=High",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const attributes = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Priority=High"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}

export function isSecureCookie(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.NODE_ENV === "production";
}
