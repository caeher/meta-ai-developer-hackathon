import { describe, expect, it } from "vitest";
import { createAuthGuards, AuthenticationRequiredError } from "../apps/web/server/auth/guards.js";
import { assertSameOriginRequest, OriginValidationError } from "../apps/web/server/auth/http.js";
import {
  clearSessionCookie,
  createOpaqueToken,
  createSessionManager,
  hashPassword,
  hashRateLimitKey,
  hashToken,
  isRateLimited,
  nextRateLimitState,
  progressiveLockDuration,
  readSessionCookie,
  sessionCookie,
  type SessionRecord,
  type SessionStore,
  verifyPassword,
} from "../apps/web/server/auth/core.js";
import { OwnedResourceNotFoundError } from "@meta-game/db";

class MemorySessionStore implements SessionStore {
  readonly records = new Map<string, SessionRecord>();
  async create(record: SessionRecord) { this.records.set(record.tokenHash, record); }
  async get(tokenHash: string) { return this.records.get(tokenHash) ?? null; }
  async extend(tokenHash: string, now: Date, expiresAt: Date) {
    const current = this.records.get(tokenHash);
    if (current) this.records.set(tokenHash, { ...current, lastSeenAt: now, expiresAt });
  }
  async revoke(tokenHash: string, now: Date) {
    const current = this.records.get(tokenHash);
    if (current) this.records.set(tokenHash, { ...current, revokedAt: now });
  }
  async revokeAll(userId: string, now: Date) {
    for (const [hash, current] of this.records) {
      if (current.userId === userId && !current.revokedAt) this.records.set(hash, { ...current, revokedAt: now });
    }
  }
}

const now = new Date("2026-11-02T12:00:00.000Z");

describe("auth propia", () => {
  it("hashes passwords with scrypt and verifies them without storing plaintext", async () => {
    const hash = await hashPassword("juego-seguro-2026");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(hash).not.toContain("juego-seguro-2026");
    await expect(verifyPassword("juego-seguro-2026", hash)).resolves.toBe(true);
    await expect(verifyPassword("otra-contraseña", hash)).resolves.toBe(false);
    await expect(hashPassword("short")).rejects.toThrow();
  });

  it("stores only a SHA-256 digest for a random 256-bit session token", () => {
    const token = createOpaqueToken();
    const digest = hashToken(token);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(token);
  });

  it("keeps rate-limit buckets pseudonymous with a keyed digest", () => {
    const address = "person@example.test";
    const first = hashRateLimitKey(address, { NODE_ENV: "test", AUTH_SECRET: "a".repeat(32) });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(address);
    expect(hashRateLimitKey(address, { NODE_ENV: "test", AUTH_SECRET: "a".repeat(32) })).toBe(first);
    expect(hashRateLimitKey(address, { NODE_ENV: "test", AUTH_SECRET: "b".repeat(32) })).not.toBe(first);
    expect(() => hashRateLimitKey(address, { NODE_ENV: "production", AUTH_SECRET: "placeholder" })).toThrow();
  });

  it("rotates a session on login, slides expiry, respects the absolute expiry, and revokes all sessions", async () => {
    const store = new MemorySessionStore();
    const manager = createSessionManager(store, { slidingTtlMs: 1_000, absoluteTtlMs: 4_000 });
    const first = await manager.create("user_authFixture001", undefined, now);
    expect(await manager.resolve(first.token, now)).toEqual({ userId: "user_authFixture001" });
    const second = await manager.create("user_authFixture001", first.token, new Date(now.getTime() + 100));
    expect(await manager.resolve(first.token, new Date(now.getTime() + 100))).toBeNull();
    expect(await manager.resolve(second.token, new Date(now.getTime() + 1_000))).toEqual({ userId: "user_authFixture001" });
    expect(store.records.get(hashToken(second.token))?.expiresAt.getTime()).toBe(now.getTime() + 2_000);
    await manager.resolve(second.token, new Date(now.getTime() + 1_900));
    expect(store.records.get(hashToken(second.token))?.expiresAt.getTime()).toBe(now.getTime() + 2_900);
    await manager.resolve(second.token, new Date(now.getTime() + 2_800));
    expect(store.records.get(hashToken(second.token))?.expiresAt.getTime()).toBe(now.getTime() + 3_800);
    await manager.resolve(second.token, new Date(now.getTime() + 3_700));
    expect(store.records.get(hashToken(second.token))?.expiresAt.getTime()).toBe(now.getTime() + 4_100);
    expect(await manager.resolve(second.token, new Date(now.getTime() + 4_099))).toEqual({ userId: "user_authFixture001" });
    expect(await manager.resolve(second.token, new Date(now.getTime() + 4_100))).toBeNull();
    const active = await manager.create("user_authFixture001", undefined, now);
    await manager.revokeAll("user_authFixture001", now);
    expect(await manager.resolve(active.token, now)).toBeNull();
  });

  it("revokes a session and sets host-only HttpOnly SameSite=Lax cookies", async () => {
    const store = new MemorySessionStore();
    const manager = createSessionManager(store, { slidingTtlMs: 1_000, absoluteTtlMs: 2_000 });
    const session = await manager.create("user_authFixture002", undefined, now);
    const cookie = sessionCookie(session.token, session.expiresAt, true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");
    expect(readSessionCookie(`other=value; ${cookie}`)).toBe(session.token);
    await manager.revoke(session.token, now);
    expect(await manager.resolve(session.token, now)).toBeNull();
    expect(clearSessionCookie(false)).toContain("Max-Age=0");
  });

  it("applies a hashed, progressive lockout that resets after its window", () => {
    expect(progressiveLockDuration(4)).toBe(0);
    expect(progressiveLockDuration(5)).toBe(60_000);
    expect(progressiveLockDuration(8)).toBe(300_000);
    expect(progressiveLockDuration(10)).toBe(1_800_000);
    let state = null;
    for (let count = 1; count <= 5; count += 1) state = nextRateLimitState(state, new Date(now.getTime() + count));
    expect(isRateLimited(state, new Date(now.getTime() + 5))).toBe(true);
    const afterWindow = nextRateLimitState(state, new Date(now.getTime() + 16 * 60_000));
    expect(afterWindow.failures).toBe(1);
  });

  it("rejects mutations without the exact allowed Origin", () => {
    expect(() => assertSameOriginRequest(new Request("http://localhost", { method: "POST", headers: { origin: "https://other.example" } }), ["http://localhost"])).toThrow(OriginValidationError);
    expect(() => assertSameOriginRequest(new Request("http://localhost", { method: "POST" }), ["http://localhost"])).toThrow(OriginValidationError);
    expect(() => assertSameOriginRequest(new Request("http://localhost", { method: "POST", headers: { origin: "http://localhost", "sec-fetch-site": "cross-site" } }), ["http://localhost"])).toThrow(OriginValidationError);
    expect(() => assertSameOriginRequest(new Request("http://localhost", { method: "POST", headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" } }), ["http://localhost"])).not.toThrow();
  });

  it("requires a verified session and returns the same not-found boundary for every foreign resource", async () => {
    const project = { id: "22222222-2222-4222-8222-222222222222", owner: "user_authOwnerA001" };
    const guards = createAuthGuards(async () => ({ userId: "user_authOwnerA001" }));
    const identityA = await guards.requireUser();
    const foreignGuards = createAuthGuards(async () => ({ userId: "user_authOwnerB001" }));
    const identityB = await foreignGuards.requireUser();
    const resources = ["project", "message", "asset", "preview"] as const;
    for (const kind of resources) {
      const ownerOnly = {
        async get(identity: { userId: string }, id: string) {
          return identity.userId === project.owner && id === `${kind}:${project.id}` ? { kind, id } : undefined;
        },
      };
      await expect(guards.requireProjectOwner(identityA, `${kind}:${project.id}`, ownerOnly)).resolves.toMatchObject({ kind });
      await expect(foreignGuards.requireProjectOwner(identityB, `${kind}:${project.id}`, ownerOnly)).rejects.toBeInstanceOf(OwnedResourceNotFoundError);
    }
    const missing = createAuthGuards(async () => ({ userId: null }));
    await expect(missing.requireUser()).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });
});
