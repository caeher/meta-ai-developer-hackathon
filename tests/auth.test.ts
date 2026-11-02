import { beforeEach, describe, expect, it } from "vitest";
import {
  identityFromAuthenticatedSession,
  OwnedResourceNotFoundError,
  type VerifiedIdentityContext,
} from "@meta-game/db";
import { hasClerkCredentials, isProtectedPath, parseAuthorizedParties } from "../apps/web/server/auth/config-core.js";
import { AuthenticationRequiredError, createAuthGuards } from "../apps/web/server/auth/guards.js";
import { apiErrorResponse, assertSameOriginRequest, OriginValidationError } from "../apps/web/server/auth/http.js";
import { createProjectHandlers } from "../apps/web/server/projects/handlers.js";

const ownerA = "user_syntheticA";
const ownerB = "user_syntheticB";
const projectId = "11111111-1111-4111-8111-111111111111";
const createdAt = new Date("2026-01-01T00:00:00.000Z");

function projectFixture(owner: string) {
  return {
    id: projectId,
    ownerUserId: "internal-owner-id",
    name: "Synthetic project",
    createdAt,
    updatedAt: createdAt,
    owner,
  };
}

describe("configuración de Clerk y rutas", () => {
  it("no activa Clerk con placeholders y acepta claves con formato Clerk", () => {
    expect(hasClerkCredentials({
      publishableKey: "pk_test_placeholder",
      secretKey: "sk_test_placeholder",
    })).toBe(false);
    expect(hasClerkCredentials({
      publishableKey: "[REDACTED_STRIPE_KEY]",
      secretKey: "[REDACTED_STRIPE_KEY]",
    })).toBe(true);
    expect(hasClerkCredentials({
      publishableKey: "[REDACTED_STRIPE_KEY]",
      secretKey: "[REDACTED_STRIPE_KEY]",
    })).toBe(false);
  });

  it("normaliza los authorized parties y rechaza URLs con rutas u orígenes inseguros", () => {
    expect(parseAuthorizedParties("http://localhost:3000, https://forja.example", undefined)).toEqual([
      "http://localhost:3000",
      "https://forja.example",
    ]);
    expect(parseAuthorizedParties(undefined, "http://localhost:3000/" )).toEqual(["http://localhost:3000"]);
    expect(() => parseAuthorizedParties("https://forja.example/extra", undefined)).toThrow(/solo orígenes/);
    expect(() => parseAuthorizedParties("http://forja.example", undefined)).toThrow(/solo orígenes/);
  });

  it("deja públicas solo las rutas explícitas de entrada y salud", () => {
    expect(isProtectedPath("/")).toBe(false);
    expect(isProtectedPath("/api/health")).toBe(false);
    expect(isProtectedPath("/sign-in/verify")).toBe(false);
    expect(isProtectedPath("/editor")).toBe(true);
    expect(isProtectedPath("/api/projects/123")).toBe(true);
    expect(isProtectedPath("/future/private-page")).toBe(true);
  });
});

describe("guards de sesión y ownership", () => {
  it("rechaza una sesión ausente y deriva identidad solo de la sesión autenticada", async () => {
    const absentSession = createAuthGuards(async () => ({ userId: null }));
    await expect(absentSession.requireUser()).rejects.toBeInstanceOf(AuthenticationRequiredError);

    const authenticatedSession = createAuthGuards(async () => ({ userId: ownerA }));
    const identity = await authenticatedSession.requireUser();
    expect(identity.clerkUserId).toBe(ownerA);
    expect(Object.getOwnPropertySymbols(identity)).toHaveLength(1);
  });

  it("devuelve 404 uniforme si el repositorio no encuentra un recurso de otro owner", async () => {
    const identityA = identityFromAuthenticatedSession({ userId: ownerA });
    const identityB = identityFromAuthenticatedSession({ userId: ownerB });
    const fixture = projectFixture(ownerA);
    const projects = {
      async get(identity: VerifiedIdentityContext, id: string) {
        return id === fixture.id && identity.clerkUserId === fixture.owner ? fixture : undefined;
      },
    };

    await expect(createAuthGuards(async () => ({ userId: ownerA })).requireProjectOwner(identityA, projectId, projects))
      .resolves.toBe(fixture);
    await expect(createAuthGuards(async () => ({ userId: ownerB })).requireProjectOwner(identityB, projectId, projects))
      .rejects.toBeInstanceOf(OwnedResourceNotFoundError);
  });
});

describe("API de proyecto con dos identidades sintéticas", () => {
  let activeUserId: string | null = ownerA;
  let project = projectFixture(ownerA);
  const authGuards = createAuthGuards(async () => ({ userId: activeUserId }));
  const projects = {
    async get(identity: VerifiedIdentityContext, id: string) {
      return id === project.id && identity.clerkUserId === project.owner ? project : undefined;
    },
    async rename(identity: VerifiedIdentityContext, id: string, name: string) {
      if (id !== project.id || identity.clerkUserId !== project.owner) throw new OwnedResourceNotFoundError();
      project = { ...project, name, updatedAt: new Date("2026-01-02T00:00:00.000Z") };
      return project;
    },
  };
  const handlers = createProjectHandlers({
    authenticator: authGuards,
    projects: projects as unknown as Parameters<typeof createProjectHandlers>[0]["projects"],
    allowedOrigins: ["http://localhost:3000"],
  });
  const context = { params: Promise.resolve({ projectId }) };

  beforeEach(() => {
    activeUserId = ownerA;
    project = projectFixture(ownerA);
  });

  it("permite que A lea su proyecto y evita filtrar campos internos", async () => {
    activeUserId = ownerA;
    const response = await handlers.GET(new Request("http://localhost:3000/api/projects/test"), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({ id: projectId, name: "Synthetic project" });
    expect(payload).not.toHaveProperty("ownerUserId");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("impide lecturas y mutaciones cruzadas aunque el body envíe otro userId", async () => {
    activeUserId = ownerB;
    const getResponse = await handlers.GET(new Request(
      `http://localhost:3000/api/projects/test?userId=${ownerA}`,
      { headers: { "x-user-id": ownerA } },
    ), context);
    expect(getResponse.status).toBe(404);

    const patchResponse = await handlers.PATCH(new Request("http://localhost:3000/api/projects/test", {
      method: "PATCH",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ name: "forged change", userId: ownerA }),
    }), context);
    expect(patchResponse.status).toBe(404);
    expect(project.name).toBe("Synthetic project");
  });

  it("ignora userId del cliente y usa la identidad A de sesión para mutar", async () => {
    activeUserId = ownerA;
    const response = await handlers.PATCH(new Request("http://localhost:3000/api/projects/test", {
      method: "PATCH",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ name: "Owner A rename", userId: ownerB }),
    }), context);
    expect(response.status).toBe(200);
    expect(project.owner).toBe(ownerA);
    expect(project.name).toBe("Owner A rename");
  });

  it("responde 401 sin sesión y 403 a un origen externo o ausente", async () => {
    activeUserId = null;
    const unauthenticated = await handlers.GET(new Request("http://localhost:3000/api/projects/test"), context);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({ error: "unauthenticated" });

    activeUserId = ownerA;
    const crossSite = new Request("http://localhost:3000/api/projects/test", {
      method: "PATCH",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ name: "blocked" }),
    });
    expect(() => assertSameOriginRequest(crossSite, ["http://localhost:3000"])).toThrow(OriginValidationError);
    const rejected = await handlers.PATCH(crossSite, context);
    expect(rejected.status).toBe(403);
    expect(project.name).toBe("Synthetic project");

    const noOrigin = new Request("http://localhost:3000/api/projects/test", { method: "PATCH" });
    expect(() => assertSameOriginRequest(noOrigin, ["http://localhost:3000"])).toThrow(OriginValidationError);
  });

  it("limita el tamaño del JSON antes de parsearlo y mutarlo", async () => {
    activeUserId = ownerA;
    const response = await handlers.PATCH(new Request("http://localhost:3000/api/projects/test", {
      method: "PATCH",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(20_000) }),
    }), context);
    expect(response.status).toBe(400);
    expect(project.name).toBe("Synthetic project");
  });

  it("mapea errores sin revelar detalles ni permitir caché", async () => {
    const response = apiErrorResponse(new Error("private failure details"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private failure details");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
