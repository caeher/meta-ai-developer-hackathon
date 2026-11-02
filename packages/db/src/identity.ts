import { z } from "zod";

const clerkUserIdSchema = z.string().regex(/^user_[A-Za-z0-9]{1,240}$/, "Identidad Clerk inválida");
const verifiedIdentityBrand: unique symbol = Symbol("verified-identity");

/**
 * Contexto de identidad creado en el servidor únicamente a partir del resultado de `auth()`
 * de Clerk. Nunca construirlo con body, query, prompt ni cabeceras controladas por el cliente.
 */
export type VerifiedIdentityContext = Readonly<{
  clerkUserId: string;
  [verifiedIdentityBrand]: true;
}>;

export function identityFromAuthenticatedSession(session: { userId: string | null }): VerifiedIdentityContext {
  const parsed = clerkUserIdSchema.safeParse(session.userId);
  if (!parsed.success) throw new Error("Se requiere una sesión de Clerk autenticada");
  const clerkUserId = parsed.data;
  return Object.freeze({ clerkUserId, [verifiedIdentityBrand]: true as const });
}

export function assertVerifiedIdentityContext(
  value: VerifiedIdentityContext,
): asserts value is VerifiedIdentityContext {
  if (value[verifiedIdentityBrand] !== true) {
    throw new TypeError("Se requiere una identidad de servidor verificada");
  }
}

export class OwnedResourceNotFoundError extends Error {
  constructor() {
    super("Recurso no encontrado");
    this.name = "OwnedResourceNotFoundError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("La clave de idempotencia ya se usó para otra operación");
    this.name = "IdempotencyConflictError";
  }
}
