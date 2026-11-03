import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { GameDatabase } from "@meta-game/db";
import { assets, authRateLimits, authSessions, authTokens, projectCleanupTasks, projects, publications, runOutbox, runs, sandboxes, usageReservations, users, versions } from "@meta-game/db";
import {
  clearSessionCookie,
  createOpaqueToken,
  createSessionManager,
  createUserId,
  hashPassword,
  hashRateLimitKey,
  hashToken,
  isRateLimited,
  isSecureCookie,
  nextRateLimitState,
  normalizeEmail,
  passwordSchema,
  readSessionCookie,
  sessionCookie,
  verifyPassword,
} from "./core";
import type { SessionStore } from "./core";
import { getAllowedOrigins, getPrimaryAppOrigin } from "./config";
import type { Mailer } from "./mailer";
import { apiErrorResponse, assertSameOriginRequest, readLimitedJson } from "./http";

const registerSchema = z.object({ email: z.string(), password: z.string(), contributorConsent: z.literal(true) }).strict();
const loginSchema = z.object({ email: z.string(), password: z.string() }).strict();
const tokenSchema = z.object({ token: z.string().min(20).max(256) }).strict();
const resetSchema = z.object({ token: z.string().min(20).max(256), password: z.string() }).strict();
const deleteAccountSchema = z.object({ password: z.string().min(1).max(128) }).strict();
const metadata = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const EMAIL_TTL_MS = 30 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
let cachedDummyHash: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!cachedDummyHash) {
    cachedDummyHash = hashPassword('not-a-real-account-password-for-timing-mitigation');
    cachedDummyHash.catch(() => { cachedDummyHash = null; });
  }
  return cachedDummyHash;
}


type PublicUser = { userId: string; email: string };

export function createDrizzleSessionStore(database: GameDatabase): SessionStore {
  return {
    async create(record) {
      const [user] = await database.select({ id: users.id }).from(users).where(and(
        eq(users.userId, record.userId), isNull(users.deletedAt),
      )).limit(1);
      if (!user) throw new Error("auth_session_user_missing");
      await database.insert(authSessions).values({
        tokenHash: record.tokenHash,
        userRowId: user.id,
        createdAt: record.createdAt,
        lastSeenAt: record.lastSeenAt,
        expiresAt: record.expiresAt,
        absoluteExpiresAt: record.absoluteExpiresAt,
        revokedAt: record.revokedAt,
      });
    },
    async get(tokenHashValue) {
      const [row] = await database.select({
        tokenHash: authSessions.tokenHash,
        userId: users.userId,
        createdAt: authSessions.createdAt,
        lastSeenAt: authSessions.lastSeenAt,
        expiresAt: authSessions.expiresAt,
        absoluteExpiresAt: authSessions.absoluteExpiresAt,
        revokedAt: authSessions.revokedAt,
      }).from(authSessions).innerJoin(users, eq(users.id, authSessions.userRowId))
        .where(and(eq(authSessions.tokenHash, tokenHashValue), isNull(users.deletedAt))).limit(1);
      return row ?? null;
    },
    async extend(tokenHashValue, now, expiresAt) {
      await database.update(authSessions).set({ lastSeenAt: now, expiresAt })
        .where(and(eq(authSessions.tokenHash, tokenHashValue), isNull(authSessions.revokedAt)));
    },
    async revoke(tokenHashValue, now) {
      await database.update(authSessions).set({ revokedAt: now })
        .where(and(eq(authSessions.tokenHash, tokenHashValue), isNull(authSessions.revokedAt)));
    },
    async revokeAll(userId, now) {
      const [user] = await database.select({ id: users.id }).from(users).where(eq(users.userId, userId)).limit(1);
      if (!user) return;
      await database.update(authSessions).set({ revokedAt: now })
        .where(and(eq(authSessions.userRowId, user.id), isNull(authSessions.revokedAt)));
    },
  };
}

export function createAuthHandlers(options: {
  database: GameDatabase;
  mailer: Mailer | null;
  revokePreviewSessions?: (projectIds: readonly string[]) => Promise<void>;
}) {
  const { database, mailer } = options;
  const sessions = createSessionManager(createDrizzleSessionStore(database));

  return {
    async register(request: Request): Promise<Response> {
      try {
        assertSameOriginRequest(request, getAllowedOrigins());
        if (!mailer) return response(503, { error: "email_delivery_unavailable" });
        const parsedBody = registerSchema.safeParse(await readLimitedJson(request, 8 * 1024));
        if (!parsedBody.success) {
          const missingConsent = parsedBody.error.issues.some((issue) => issue.path.length === 1 && issue.path[0] === "contributorConsent");
          if (missingConsent) return response(400, { error: "contributor_consent_required" });
          throw parsedBody.error;
        }
        const parsed = parsedBody.data;
        const email = normalizeEmail(parsed.email);
        const password = passwordSchema.parse(parsed.password);
        if (!(await recordAllowedAttempt(database, `register:${email}`))) return response(429, { error: "try_again_later" });
        const passwordHash = await hashPassword(password);
        const consentAt = new Date();
        const [created] = await database.insert(users).values({ userId: createUserId(), email, passwordHash, contributorConsentAt: consentAt })
          .onConflictDoNothing({ target: users.email }).returning({ id: users.id });
        let user = created ? await findUserByIdRow(database, created.id) : await findUserByEmail(database, email);
        if (user && !user.contributorConsentAt) {
          await database.update(users).set({ contributorConsentAt: consentAt, updatedAt: consentAt })
            .where(and(eq(users.id, user.id), isNull(users.contributorConsentAt)));
          user = { ...user, contributorConsentAt: consentAt };
        }
        if (user && user.email && !user.emailVerifiedAt) {
          const token = await createOneTimeToken(database, user.id, "verify_email", EMAIL_TTL_MS);
          await mailer.sendVerificationEmail({ email: user.email, url: `${getPrimaryAppOrigin()}/verify-email?token=${encodeURIComponent(token)}` });
        }
        return response(202, { message: "Si la cuenta puede registrarse, recibirás un enlace de verificación." });
      } catch (error) { return apiErrorResponse(error); }
    },

    async login(request: Request): Promise<Response> {
      try {
        assertSameOriginRequest(request, getAllowedOrigins());
        const parsed = loginSchema.parse(await readLimitedJson(request, 8 * 1024));
        const email = normalizeEmail(parsed.email);
        const password = parsed.password;
        if (typeof password !== "string" || password.length > 128) return response(401, { error: "invalid_credentials" });
        const bucket = `login:${email}`;
        if (await isEmailLocked(database, bucket)) return response(401, { error: "invalid_credentials" });
        const user = await findUserByEmail(database, email);
        const storedHash = user?.passwordHash ?? await getDummyPasswordHash();
        const passwordMatches = await verifyPassword(password, storedHash);
        if (!user || !user.passwordHash || !user.emailVerifiedAt || !passwordMatches) {
          await recordFailure(database, bucket);
          return response(401, { error: "invalid_credentials" });
        }
        await clearRateLimit(database, bucket);
        const previousToken = readSessionCookie(request.headers.get("cookie"));
        const session = await sessions.create(user.userId, previousToken ?? undefined);
        return response(200, { user: publicUser(user) }, sessionCookie(session.token, session.absoluteExpiresAt, isSecureCookie()));
      } catch (error) { return apiErrorResponse(error); }
    },

    async logout(request: Request): Promise<Response> {
      try {
        assertSameOriginRequest(request, getAllowedOrigins());
        await sessions.revoke(readSessionCookie(request.headers.get("cookie")));
        return response(200, { ok: true }, clearSessionCookie(isSecureCookie()));
      } catch (error) { return apiErrorResponse(error); }
    },

    async logoutAll(request: Request): Promise<Response> {
      try {
        assertSameOriginRequest(request, getAllowedOrigins());
        const token = readSessionCookie(request.headers.get("cookie"));
        const active = await sessions.resolve(token);
        if (active) await sessions.revokeAll(active.userId);
        return response(200, { ok: true }, clearSessionCookie(isSecureCookie()));
      } catch (error) { return apiErrorResponse(error); }
    },

    async deleteAccount(request: Request): Promise<Response> {
      try {
        assertSameOriginRequest(request, getAllowedOrigins());
        const session = await sessions.resolve(readSessionCookie(request.headers.get("cookie")));
        if (!session) return response(401, { error: "unauthenticated" });
        const { password } = deleteAccountSchema.parse(await readLimitedJson(request, 8 * 1024));
        const user = await findUserById(database, session.userId);
        if (!user?.passwordHash || !await verifyPassword(password, user.passwordHash)) {
          return response(401, { error: "invalid_credentials" });
        }
        const now = new Date();
        const deletedProjects = await database.transaction(async (tx) => {
          const [owner] = await tx.select({ id: users.id }).from(users).where(and(
            eq(users.userId, session.userId), isNull(users.deletedAt),
          )).for("update").limit(1);
          if (!owner) return [] as string[];
          const ownedProjects = await tx.select({ id: projects.id }).from(projects).where(and(
            eq(projects.ownerUserId, owner.id), isNull(projects.deletedAt),
          )).for("update");
          const projectIds = ownedProjects.map(({ id }) => id);
          await options.revokePreviewSessions?.(projectIds);
          await tx.update(users).set({
            deletedAt: now, email: null, passwordHash: null, emailVerifiedAt: null, updatedAt: now,
          }).where(eq(users.id, owner.id));
          await tx.update(authSessions).set({ revokedAt: now }).where(and(
            eq(authSessions.userRowId, owner.id), isNull(authSessions.revokedAt),
          ));
          await tx.update(authTokens).set({ consumedAt: now }).where(and(
            eq(authTokens.userRowId, owner.id), isNull(authTokens.consumedAt),
          ));
          if (projectIds.length) {
            const ownedProjectIds = inArray(projects.id, projectIds);
            await tx.update(projects).set({ deletedAt: now, name: "Proyecto eliminado", updatedAt: now }).where(ownedProjectIds);
            await tx.update(runs).set({ status: "cancelled", errorCode: "project_deleted", updatedAt: now }).where(and(
              eq(runs.ownerUserId, owner.id), inArray(runs.projectId, projectIds), inArray(runs.status, ["queued", "planning", "running", "verifying"]),
            ));
            await tx.update(runOutbox).set({
              status: "cancelled", leaseToken: null, leaseExpiresAt: null, updatedAt: now,
            }).where(and(eq(runOutbox.ownerUserId, owner.id), inArray(runOutbox.projectId, projectIds)));
            await tx.update(sandboxes).set({
              status: "stopping", lifecycleLeaseToken: null, lifecycleLeaseExpiresAt: null, updatedAt: now,
            }).where(and(eq(sandboxes.ownerUserId, owner.id), inArray(sandboxes.projectId, projectIds)));
            await tx.update(assets).set({ status: "delete_requested", updatedAt: now }).where(and(
              eq(assets.ownerUserId, owner.id), inArray(assets.projectId, projectIds),
            ));
            await tx.update(versions).set({ status: "delete_requested" }).where(and(
              eq(versions.ownerUserId, owner.id), inArray(versions.projectId, projectIds),
            ));
            await tx.update(publications).set({
              status: "revoked", buildLeaseToken: null, buildLeaseExpiresAt: null, updatedAt: now,
            }).where(and(eq(publications.ownerUserId, owner.id), inArray(publications.projectId, projectIds)));
            await tx.update(usageReservations).set({ status: "released", updatedAt: now }).where(and(
              eq(usageReservations.ownerUserId, owner.id), inArray(usageReservations.projectId, projectIds), eq(usageReservations.status, "reserved"),
            ));
            await tx.insert(projectCleanupTasks).values(projectIds.map((projectId) => ({ ownerUserId: owner.id, projectId })))
              .onConflictDoNothing({ target: [projectCleanupTasks.ownerUserId, projectCleanupTasks.projectId] });
          }
          return projectIds;
        });
        if (!deletedProjects.length) {
          const [stillActive] = await database.select({ id: users.id }).from(users).where(and(
            eq(users.userId, session.userId), isNull(users.deletedAt),
          )).limit(1);
          if (stillActive) return response(200, { deleted: true, projectsQueued: 0 }, clearSessionCookie(isSecureCookie()));
        }
        return response(202, { deleted: true, projectsQueued: deletedProjects.length }, clearSessionCookie(isSecureCookie()));
      } catch (error) { return apiErrorResponse(error); }
    },

    async session(request: Request): Promise<Response> {
      try {
        const user = await resolveCurrentUser(database, readSessionCookie(request.headers.get("cookie")));
        return response(200, { user });
      } catch { return response(200, { user: null }); }
    },

    async forgotPassword(request: Request): Promise<Response> {
      try {
        assertSameOriginRequest(request, getAllowedOrigins());
        if (!mailer) return response(503, { error: "email_delivery_unavailable" });
        const parsed = z.object({ email: z.string() }).strict().parse(await readLimitedJson(request, 8 * 1024));
        const email = normalizeEmail(parsed.email);
        if (!(await recordAllowedAttempt(database, `recovery:${email}`))) return response(429, { error: "try_again_later" });
        const user = await findUserByEmail(database, email);
        if (user?.email && user.emailVerifiedAt) {
          const token = await createOneTimeToken(database, user.id, "reset_password", RESET_TTL_MS);
          await mailer.sendPasswordResetEmail({ email: user.email, url: `${getPrimaryAppOrigin()}/reset-password?token=${encodeURIComponent(token)}` });
        }
        return response(202, { message: "Si la cuenta existe, recibirás instrucciones para restablecer la contraseña." });
      } catch (error) { return apiErrorResponse(error); }
    },

    async verifyEmail(request: Request): Promise<Response> {
      try {
        assertSameOriginRequest(request, getAllowedOrigins());
        const { token } = tokenSchema.parse(await readLimitedJson(request, 8 * 1024));
        const valid = await consumeEmailVerification(database, token);
        return valid
          ? response(200, { ok: true })
          : response(400, { error: "invalid_or_expired_link" });
      } catch (error) { return apiErrorResponse(error); }
    },

    async resetPassword(request: Request): Promise<Response> {
      try {
        assertSameOriginRequest(request, getAllowedOrigins());
        const parsed = resetSchema.parse(await readLimitedJson(request, 8 * 1024));
        const password = passwordSchema.parse(parsed.password);
        if (!(await recordAllowedAttempt(database, `reset:${hashToken(parsed.token)}`))) return response(429, { error: "try_again_later" });
        const passwordHash = await hashPassword(password);
        const success = await consumePasswordReset(database, parsed.token, passwordHash);
        return success
          ? response(200, { ok: true }, clearSessionCookie(isSecureCookie()))
          : response(400, { error: "invalid_or_expired_link" });
      } catch (error) { return apiErrorResponse(error); }
    },
  };
}

export async function resolveCurrentUser(database: GameDatabase, token: string | null): Promise<PublicUser | null> {
  const session = await createSessionManager(createDrizzleSessionStore(database)).resolve(token);
  if (!session) return null;
  const user = await findUserById(database, session.userId);
  return user?.email && user.emailVerifiedAt ? publicUser(user) : null;
}

async function findUserByEmail(database: GameDatabase, email: string) {
  const [user] = await database.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt))).limit(1);
  return user ?? null;
}

async function findUserById(database: GameDatabase, userId: string) {
  const [user] = await database.select().from(users).where(and(eq(users.userId, userId), isNull(users.deletedAt))).limit(1);
  return user ?? null;
}

async function findUserByIdRow(database: GameDatabase, id: string) {
  const [user] = await database.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

function publicUser(user: { userId: string; email: string | null }): PublicUser | null {
  return user.email ? { userId: user.userId, email: user.email } : null;
}

async function createOneTimeToken(
  database: GameDatabase,
  userRowId: string,
  purpose: "verify_email" | "reset_password",
  ttlMs: number,
): Promise<string> {
  const token = createOpaqueToken();
  const now = new Date();
  await database.transaction(async (tx) => {
    await tx.update(authTokens).set({ consumedAt: now }).where(and(
      eq(authTokens.userRowId, userRowId),
      eq(authTokens.purpose, purpose),
      isNull(authTokens.consumedAt),
    ));
    await tx.insert(authTokens).values({
      userRowId,
      tokenHash: hashToken(token),
      purpose,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    });
  });
  return token;
}

async function consumeEmailVerification(database: GameDatabase, token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const now = new Date();
  return database.transaction(async (tx) => {
    const [entry] = await tx.select().from(authTokens).where(and(
      eq(authTokens.tokenHash, tokenHash),
      eq(authTokens.purpose, "verify_email"),
      isNull(authTokens.consumedAt),
      gt(authTokens.expiresAt, now),
    )).for("update").limit(1);
    if (!entry) return false;
    await tx.update(authTokens).set({ consumedAt: now }).where(eq(authTokens.id, entry.id));
    await tx.update(users).set({ emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, entry.userRowId));
    return true;
  });
}

async function consumePasswordReset(database: GameDatabase, token: string, passwordHash: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const now = new Date();
  return database.transaction(async (tx) => {
    const [entry] = await tx.select().from(authTokens).where(and(
      eq(authTokens.tokenHash, tokenHash),
      eq(authTokens.purpose, "reset_password"),
      isNull(authTokens.consumedAt),
      gt(authTokens.expiresAt, now),
    )).for("update").limit(1);
    if (!entry) return false;
    await tx.update(authTokens).set({ consumedAt: now }).where(and(
      eq(authTokens.userRowId, entry.userRowId),
      eq(authTokens.purpose, "reset_password"),
      isNull(authTokens.consumedAt),
    ));
    await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, entry.userRowId));
    await tx.update(authSessions).set({ revokedAt: now }).where(and(
      eq(authSessions.userRowId, entry.userRowId),
      isNull(authSessions.revokedAt),
    ));
    return true;
  });
}

async function isEmailLocked(database: GameDatabase, bucket: string): Promise<boolean> {
  const bucketHash = hashRateLimitKey(bucket);
  const [row] = await database.select().from(authRateLimits).where(eq(authRateLimits.bucketHash, bucketHash)).limit(1);
  return isRateLimited(row ? { failures: row.failures, windowStartedAt: row.windowStartedAt, lockedUntil: row.lockedUntil } : null);
}

async function recordAllowedAttempt(database: GameDatabase, bucket: string): Promise<boolean> {
  if (await isEmailLocked(database, bucket)) return false;
  const state = await recordFailure(database, bucket);
  return !isRateLimited(state);
}

async function recordFailure(database: GameDatabase, bucket: string) {
  const bucketHash = hashRateLimitKey(bucket);
  const now = new Date();
  return database.transaction(async (tx) => {
    await tx.insert(authRateLimits).values({ bucketHash, failures: 0, windowStartedAt: now })
      .onConflictDoNothing({ target: authRateLimits.bucketHash });
    const [current] = await tx.select().from(authRateLimits).where(eq(authRateLimits.bucketHash, bucketHash)).for("update").limit(1);
    const next = nextRateLimitState(current ? {
      failures: current.failures,
      windowStartedAt: current.windowStartedAt,
      lockedUntil: current.lockedUntil,
    } : null, now);
    const [updated] = await tx.update(authRateLimits).set({
      failures: next.failures,
      windowStartedAt: next.windowStartedAt,
      lockedUntil: next.lockedUntil,
      updatedAt: now,
    }).where(eq(authRateLimits.bucketHash, bucketHash)).returning();
    return updated ?? next;
  });
}

async function clearRateLimit(database: GameDatabase, bucket: string): Promise<void> {
  const bucketHash = hashRateLimitKey(bucket);
  await database.delete(authRateLimits).where(eq(authRateLimits.bucketHash, bucketHash));
}

function response(status: number, body: unknown, cookie?: string): Response {
  const headers = new Headers(metadata);
  if (cookie) headers.append("set-cookie", cookie);
  return Response.json(body, { status, headers });
}


