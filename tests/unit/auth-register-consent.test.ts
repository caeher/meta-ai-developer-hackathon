import { describe, expect, it, vi } from "vitest";
import { users, type GameDatabase } from "@meta-game/db";
import { createAuthHandlers } from "../../apps/web/server/auth/service.js";
import type { Mailer } from "../../apps/web/server/auth/mailer.js";

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/auth/${path}`, {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface FakeState {
  userRow: Record<string, unknown> | null;
  insertReturning: Array<Record<string, unknown>>;
  inserted: Array<Record<string, unknown>>;
  updated: Array<{ patch: Record<string, unknown> }>;
  mails: number;
}

function chainable(terminal: () => Promise<unknown>) {
  const q: Record<string, (...args: never[]) => unknown> = {};
  q.from = () => q;
  q.values = () => q;
  q.set = () => q;
  q.where = () => q;
  q.for = () => q;
  q.onConflictDoNothing = () => q;
  q.onConflictDoUpdate = () => q;
  q.returning = terminal;
  q.limit = terminal;
  q.then = (onFulfilled?: unknown, onRejected?: unknown) =>
    Promise.resolve(undefined).then(onFulfilled as never, onRejected as never);
  return q;
}

function makeFakeDb(state: FakeState): GameDatabase {
  const db: Record<string, (...args: never[]) => unknown> = {};
  db.select = () => {
    let table: unknown = null;
    const q = chainable(() =>
      Promise.resolve(table === users ? (state.userRow ? [state.userRow] : []) : []),
    );
    q.from = (t: unknown) => {
      table = t;
      return q;
    };
    return q;
  };
  db.insert = () => {
    const q = chainable(() => Promise.resolve(state.insertReturning));
    q.values = (payload: unknown) => {
      state.inserted.push(payload as Record<string, unknown>);
      return q;
    };
    return q;
  };
  db.update = () => {
    const q = chainable(() => Promise.resolve([{ ok: true }]));
    q.set = (patch: unknown) => {
      state.updated.push({ patch: patch as Record<string, unknown> });
      return q;
    };
    return q;
  };
  db.transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(db);
  return db as unknown as GameDatabase;
}
function makeMailer(state: FakeState): Mailer & { sendVerificationEmail: ReturnType<typeof vi.fn> } {
  const sendVerificationEmail = vi.fn(async () => {
    state.mails += 1;
  });
  return {
    sendVerificationEmail,
    sendPasswordResetEmail: vi.fn(async () => undefined),
  } as unknown as Mailer & { sendVerificationEmail: ReturnType<typeof vi.fn> };
}

const password = "juego-seguro-001";

describe("registro con consentimiento Contributor", () => {
  it("rechaza el registro sin confirmacion sin crear usuario ni enviar correo", async () => {
    const state: FakeState = { userRow: null, insertReturning: [], inserted: [], updated: [], mails: 0 };
    const handlers = createAuthHandlers({ database: makeFakeDb(state), mailer: makeMailer(state) });
    const response = await handlers.register(post("register", { email: "jugador@example.test", password }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "contributor_consent_required" });
    expect(state.inserted).toHaveLength(0);
    expect(state.mails).toBe(0);
  });

  it("registra con contributorConsent:true y guarda consent_at", async () => {
    const state: FakeState = { userRow: null, insertReturning: [], inserted: [], updated: [], mails: 0 };
    state.insertReturning = [{ id: "row-new" }];
    state.userRow = {
      id: "row-new",
      email: "jugador@example.test",
      emailVerifiedAt: null,
      contributorConsentAt: new Date("2026-11-03T12:00:00.000Z"),
    };
    const mailer = makeMailer(state);
    const handlers = createAuthHandlers({ database: makeFakeDb(state), mailer });
    const response = await handlers.register(
      post("register", { email: "jugador@example.test", password, contributorConsent: true }),
    );
    expect(response.status).toBe(202);
    const userInsert = state.inserted.find((row) => "passwordHash" in row);
    expect(userInsert?.email).toBe("jugador@example.test");
    expect(userInsert?.contributorConsentAt).toBeInstanceOf(Date);
    expect(mailer.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("re-registro sin casilla no fija consent_at ni reenvia verificacion", async () => {
    const state: FakeState = { userRow: null, insertReturning: [], inserted: [], updated: [], mails: 0 };
    state.userRow = {
      id: "row-existing",
      email: "jugador@example.test",
      emailVerifiedAt: null,
      contributorConsentAt: null,
    };
    const mailer = makeMailer(state);
    const handlers = createAuthHandlers({ database: makeFakeDb(state), mailer });
    const response = await handlers.register(post("register", { email: "jugador@example.test", password }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "contributor_consent_required" });
    expect(state.updated).toHaveLength(0);
    expect(mailer.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("re-registro con casilla fija consent_at y reenvia verificacion", async () => {
    const state: FakeState = { userRow: null, insertReturning: [], inserted: [], updated: [], mails: 0 };
    state.userRow = {
      id: "row-existing",
      email: "jugador@example.test",
      emailVerifiedAt: null,
      contributorConsentAt: null,
    };
    const mailer = makeMailer(state);
    const handlers = createAuthHandlers({ database: makeFakeDb(state), mailer });
    const response = await handlers.register(
      post("register", { email: "jugador@example.test", password, contributorConsent: true }),
    );
    expect(response.status).toBe(202);
    const consentPatch = state.updated.find((entry) => "contributorConsentAt" in entry.patch);
    expect(consentPatch?.patch.contributorConsentAt).toBeInstanceOf(Date);
    expect(mailer.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });
});

