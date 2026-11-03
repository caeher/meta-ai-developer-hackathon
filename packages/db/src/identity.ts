import { z } from "zod";

const userIdSchema = z.string().regex(/^user_[A-Za-z0-9]{1,240}$/, "Identidad de usuario inválida");
const verifiedIdentityBrand: unique symbol = Symbol("verified-identity");

/** Contexto creado tras validar una sesión propia en el servidor. Nunca aceptar identidad del cliente. */
export type VerifiedIdentityContext = Readonly<{
  userId: string;
  [verifiedIdentityBrand]: true;
}>;

export function identityFromAuthenticatedSession(session: { userId: string | null }): VerifiedIdentityContext {
  const parsed = userIdSchema.safeParse(session.userId);
  if (!parsed.success) throw new Error("Se requiere una sesión autenticada");
  const userId = parsed.data;
  return Object.freeze({ userId, [verifiedIdentityBrand]: true as const });
}

export function assertVerifiedIdentityContext(value: VerifiedIdentityContext): asserts value is VerifiedIdentityContext {
  if (value[verifiedIdentityBrand] !== true) throw new TypeError("Se requiere una identidad de servidor verificada");
}

export class OwnedResourceNotFoundError extends Error {
  constructor() { super("Recurso no encontrado"); this.name = "OwnedResourceNotFoundError"; }
}
export class IdempotencyConflictError extends Error {
  constructor() { super("La clave de idempotencia ya se usó para otra operación"); this.name = "IdempotencyConflictError"; }
}
export class UsageLimitExceededError extends Error {
  constructor(public readonly limit: "tokens" | "images" | "concurrency" | "storage" | "projects" | "time") { super(`Se superó el límite de uso: ${limit}`); this.name = "UsageLimitExceededError"; }
}
export class ProjectRunBusyError extends Error {
  constructor() { super("El proyecto ya tiene un run activo"); this.name = "ProjectRunBusyError"; }
}
export class ContributorConsentRequiredError extends Error {
  constructor() { super("La cuenta no registra la confirmación de mayoría de edad y términos de Meta Contributor"); this.name = "ContributorConsentRequiredError"; }
}
export class StaleRunWorkerError extends Error {
  constructor() { super("El worker perdió el lease y no puede modificar este run"); this.name = "StaleRunWorkerError"; }
}
