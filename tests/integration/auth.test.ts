import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authRateLimits, authSessions, authTokens, createDatabaseFromEnvironment, createRepositories, identityFromAuthenticatedSession, projectCleanupTasks, projects, sandboxes, users } from "@meta-game/db";
import { createAuthHandlers } from "../../apps/web/server/auth/service.js";
import { hashRateLimitKey } from "../../apps/web/server/auth/core.js";
import type { Mailer } from "../../apps/web/server/auth/mailer.js";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";

describe.skipIf(!integrationEnabled)("autenticación propia con PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const email = `auth-${suffix}@example.test`;
  const deletionEmail = `account-delete-${suffix}@example.test`;
  const createdUserIds: string[] = [];
  let database: ReturnType<typeof createDatabaseFromEnvironment>;
  const delivered: { verification?: string; reset?: string } = {};
  const mailer: Mailer = {
    async sendVerificationEmail(input) { delivered.verification = input.url; },
    async sendPasswordResetEmail(input) { delivered.reset = input.url; },
  };
  let handlers: ReturnType<typeof createAuthHandlers>;
  const rateKeys = ["login", "register", "recovery"].map((scope) => hashRateLimitKey(`${scope}:${email}`, { ...process.env, NODE_ENV: "test" }));

  beforeAll(async () => {
    process.env.AUTH_ALLOWED_ORIGINS = "http://localhost:3000";
    database = createDatabaseFromEnvironment();
    handlers = createAuthHandlers({ database: database.db, mailer });
    await database.db.delete(users).where(eq(users.email, email));
  });

  afterAll(async () => {
    if (!database) return;
    if (createdUserIds.length) await database.db.delete(users).where(inArray(users.userId, createdUserIds));
    await database.db.delete(users).where(or(eq(users.email, email), eq(users.email, deletionEmail)));
    const deletionRateKeys = ["register", "login", "recovery"].map((scope) => hashRateLimitKey(`${scope}:${deletionEmail}`, { ...process.env, NODE_ENV: "test" }));
    await database.db.delete(authRateLimits).where(inArray(authRateLimits.bucketHash, [...rateKeys, ...deletionRateKeys]));
    await database.close();
  });

  it("registra, verifica correo, rota sesiones, recupera contraseña y revoca sesiones", async () => {
    const registered = await handlers.register(post("register", { email, password: "juego-seguro-inicial" }));
    expect(registered.status).toBe(202);
    expect(delivered.verification).toBeTruthy();
    const duplicate = await handlers.register(post("register", { email, password: "otra-clave-valida-001" }));
    expect(await duplicate.json()).toEqual(await registered.clone().json());

    const verificationToken = queryToken(delivered.verification!);
    const verification = await handlers.verifyEmail(post("verify-email", { token: verificationToken }));
    expect(verification.status).toBe(200);
    expect((await handlers.verifyEmail(post("verify-email", { token: verificationToken }))).status).toBe(400);
    const user = (await database.db.select().from(users).where(eq(users.email, email)).limit(1))[0]!;
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.passwordHash).not.toContain("juego-seguro-inicial");

    const firstLogin = await handlers.login(post("login", { email, password: "juego-seguro-inicial" }));
    expect(firstLogin.status).toBe(200);
    const firstCookie = sessionToken(firstLogin);
    const storedSession = (await database.db.select().from(authSessions).where(eq(authSessions.userRowId, user.id)).limit(1))[0]!;
    expect(storedSession.tokenHash).not.toBe(firstCookie);
    expect(storedSession.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    const secondLogin = await handlers.login(post("login", { email, password: "juego-seguro-inicial" }, firstCookie));
    expect(secondLogin.status).toBe(200);
    const secondCookie = sessionToken(secondLogin);
    expect((await handlers.session(new Request("http://localhost:3000/api/auth/session", { headers: { cookie: `forja_session=${firstCookie}` } }))).status).toBe(200);
    expect(await sessionUser(handlers, firstCookie)).toBeNull();
    expect(await sessionUser(handlers, secondCookie)).toMatchObject({ email });

    const missingRequest = post("forgot-password", { email: `absent-${suffix}@example.test` });
    const missing = await handlers.forgotPassword(missingRequest);
    const requested = await handlers.forgotPassword(post("forgot-password", { email }));
    expect(missing.status).toBe(requested.status);
    expect(await missing.json()).toEqual(await requested.json());
    expect(delivered.reset).toBeTruthy();

    const resetToken = queryToken(delivered.reset!);
    const reset = await handlers.resetPassword(post("reset-password", { token: resetToken, password: "juego-seguro-nuevo" }, secondCookie));
    expect(reset.status).toBe(200);
    expect(await sessionUser(handlers, secondCookie)).toBeNull();
    expect((await database.db.select().from(authTokens).where(eq(authTokens.tokenHash, createHash("sha256").update(resetToken).digest("hex"))).limit(1))[0]?.consumedAt).toBeInstanceOf(Date);
    expect((await handlers.login(post("login", { email, password: "juego-seguro-inicial" }))).status).toBe(401);
    const finalLogin = await handlers.login(post("login", { email, password: "juego-seguro-nuevo" }));
    expect(finalLogin.status).toBe(200);
    const finalCookie = sessionToken(finalLogin);
    expect((await handlers.logout(post("logout", {}, finalCookie))).status).toBe(200);
    expect(await sessionUser(handlers, finalCookie)).toBeNull();
    const otherDeviceLogin = await handlers.login(post("login", { email, password: "juego-seguro-nuevo" }));
    const otherDeviceCookie = sessionToken(otherDeviceLogin);
    expect(await sessionUser(handlers, otherDeviceCookie)).toMatchObject({ email });
    expect((await handlers.logoutAll(post("logout-all", {}, otherDeviceCookie))).status).toBe(200);
    expect(await sessionUser(handlers, otherDeviceCookie)).toBeNull();
    expect((await handlers.resetPassword(post("reset-password", { token: resetToken, password: "juego-seguro-otra" }))).status).toBe(400);
  });

  it("rechaza CSRF y aplica el bloqueo progresivo persistido", async () => {
    const csrf = await handlers.login(new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ email, password: "incorrecta" }),
    }));
    expect(csrf.status).toBe(403);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await handlers.login(post("login", { email, password: "password-incorrecta" }));
      expect(failed.status).toBe(401);
      expect(await failed.json()).toEqual({ error: "invalid_credentials" });
    }
    const blocked = await database.db.select().from(authRateLimits).where(eq(authRateLimits.bucketHash, rateKeys[0]!)).limit(1);
    expect(blocked[0]?.failures).toBe(5);
    expect(blocked[0]?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  it("elimina cuenta propia, revoca sesiones y encola la limpieza privada con auditoría", async () => {
    const password = "cuenta-de-prueba-segura";
    expect((await handlers.register(post("register", { email: deletionEmail, password }))).status).toBe(202);
    const verification = await handlers.verifyEmail(post("verify-email", { token: queryToken(delivered.verification!) }));
    expect(verification.status).toBe(200);
    const loggedIn = await handlers.login(post("login", { email: deletionEmail, password }));
    expect(loggedIn.status).toBe(200);
    const cookie = sessionToken(loggedIn);
    const [user] = await database.db.select().from(users).where(eq(users.email, deletionEmail)).limit(1);
    if (!user) throw new Error("Account deletion test user missing");
    createdUserIds.push(user.userId);
    const identity = identityFromAuthenticatedSession({ userId: user.userId });
    const repositories = createRepositories(database.db);
    const project = await repositories.projects.create(identity, { name: "Cuenta para borrar" });
    const sandbox = await repositories.sandboxes.upsert(identity, { projectId: project.id, status: "ready", runtimeId: `account-delete-${suffix}` });
    const revokedProjects: string[] = [];
    const deletionHandlers = createAuthHandlers({
      database: database.db,
      mailer,
      revokePreviewSessions: async (projectIds) => { revokedProjects.push(...projectIds); },
    });
    expect((await deletionHandlers.deleteAccount(post("delete-account", { password: "incorrecta" }, cookie))).status).toBe(401);
    const deleted = await deletionHandlers.deleteAccount(post("delete-account", { password }, cookie));
    expect(deleted.status).toBe(202);
    expect(await sessionUser(deletionHandlers, cookie)).toBeNull();
    const [tombstone] = await database.db.select().from(users).where(eq(users.userId, user.userId)).limit(1);
    const [deletedProject] = await database.db.select().from(projects).where(eq(projects.id, project.id)).limit(1);
    const [stoppingSandbox] = await database.db.select().from(sandboxes).where(eq(sandboxes.id, sandbox.id)).limit(1);
    const [cleanup] = await database.db.select().from(projectCleanupTasks).where(eq(projectCleanupTasks.projectId, project.id)).limit(1);
    expect(tombstone).toMatchObject({ email: null, passwordHash: null, emailVerifiedAt: null });
    expect(tombstone?.deletedAt).toBeInstanceOf(Date);
    expect(deletedProject).toMatchObject({ name: "Proyecto eliminado" });
    expect(deletedProject?.deletedAt).toBeInstanceOf(Date);
    expect(stoppingSandbox?.status).toBe("stopping");
    expect(cleanup).toMatchObject({ status: "queued", projectId: project.id });
    expect(revokedProjects).toEqual([project.id]);
    await expect(repositories.projects.create(identity, { name: "No debe reactivarse" })).rejects.toThrow("Recurso no encontrado");
  });
});

function post(action: string, body: unknown, cookie?: string): Request {
  const headers = new Headers({ "content-type": "application/json", origin: "http://localhost:3000" });
  if (cookie) headers.set("cookie", `forja_session=${cookie}`);
  return new Request(`http://localhost:3000/api/auth/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
}

function queryToken(url: string): string {
  const token = new URL(url).searchParams.get("token");
  if (!token) throw new Error("Token no creado por el mailer de prueba");
  return token;
}

function sessionToken(response: Response): string {
  const token = response.headers.get("set-cookie")?.match(/forja_session=([^;]+)/)?.[1];
  if (!token) throw new Error("La respuesta no creó una cookie de sesión");
  return token;
}

async function sessionUser(handlers: ReturnType<typeof createAuthHandlers>, token: string) {
  const response = await handlers.session(new Request("http://localhost:3000/api/auth/session", { headers: { cookie: `forja_session=${token}` } }));
  const result = await response.json() as { user: { userId: string; email: string } | null };
  return result.user;
}
