import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { createDatabaseFromEnvironment } from "@meta-game/db";
import {
  messages,
  projects,
  runEvents,
  runs,
  sandboxes,
  usageLedger,
  usageReservations,
  users,
} from "@meta-game/db/schema";

const fixtures = [
  {
    ownerId: "00000000-0000-4000-8000-000000000101",
    clerkUserId: "user_fixtureAccountA001",
    projectId: "00000000-0000-4000-8000-000000000201",
    messageId: "00000000-0000-4000-8000-000000000301",
    runId: "00000000-0000-4000-8000-000000000401",
    eventId: "00000000-0000-4000-8000-000000000501",
    sandboxId: "00000000-0000-4000-8000-000000000601",
    reservationId: "00000000-0000-4000-8000-000000000701",
    projectName: "Fixture: Star Garden",
    message: "Crear un prototipo local de plataformas.",
  },
  {
    ownerId: "00000000-0000-4000-8000-000000000102",
    clerkUserId: "user_fixtureAccountB001",
    projectId: "00000000-0000-4000-8000-000000000202",
    messageId: "00000000-0000-4000-8000-000000000302",
    runId: "00000000-0000-4000-8000-000000000402",
    eventId: "00000000-0000-4000-8000-000000000502",
    sandboxId: "00000000-0000-4000-8000-000000000602",
    reservationId: "00000000-0000-4000-8000-000000000702",
    projectName: "Fixture: Moon Puzzle",
    message: "Diseñar un rompecabezas de cuadrícula.",
  },
] as const;

function assertLocalDatabaseUrl(value: string | undefined): void {
  if (process.env.NODE_ENV === "production" || !value) {
    throw new Error("db:seed requiere DATABASE_URL en entorno local; nunca se ejecuta en producción.");
  }
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    throw new Error("db:seed requiere una URL de base local válida; el valor no se registra.");
  }
  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(hostname)) {
    throw new Error("db:seed solo acepta una base en loopback; el valor no se registra.");
  }
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const { db, close } = createDatabaseFromEnvironment();
  try {
    for (const fixture of fixtures) {
    await db.transaction(async (tx) => {
      const [owner] = await tx
        .insert(users)
        .values({ id: fixture.ownerId, clerkUserId: fixture.clerkUserId })
        .onConflictDoUpdate({ target: users.clerkUserId, set: { updatedAt: new Date() } })
        .returning({ id: users.id });
      if (!owner) throw new Error("No se pudo reconciliar el usuario fixture");

      await tx
        .insert(projects)
        .values({ id: fixture.projectId, ownerUserId: owner.id, name: fixture.projectName })
        .onConflictDoNothing({ target: projects.id });
      const [project] = await tx
        .select({ id: projects.id, ownerUserId: projects.ownerUserId })
        .from(projects)
        .where(eq(projects.id, fixture.projectId))
        .limit(1);
      if (!project || project.ownerUserId !== owner.id) {
        throw new Error("El ID reservado para un proyecto fixture ya pertenece a otra fila");
      }

      await tx
        .insert(runs)
        .values({
          id: fixture.runId,
          ownerUserId: owner.id,
          projectId: project.id,
          idempotencyKey: `fixture-run-${fixture.clerkUserId}`,
          status: "succeeded",
        })
        .onConflictDoNothing({ target: runs.id });
      const [run] = await tx
        .select({ id: runs.id, projectId: runs.projectId })
        .from(runs)
        .where(
          and(eq(runs.ownerUserId, owner.id), eq(runs.id, fixture.runId)),
        )
        .limit(1);
      if (!run || run.projectId !== project.id) throw new Error("Fixture run inconsistente");

      await tx
        .insert(messages)
        .values({
          id: fixture.messageId,
          ownerUserId: owner.id,
          projectId: project.id,
          runId: run.id,
          role: "user",
          content: fixture.message,
        })
        .onConflictDoNothing({ target: messages.id });
      await tx
        .insert(runEvents)
        .values({
          id: fixture.eventId,
          ownerUserId: owner.id,
          projectId: project.id,
          runId: run.id,
          sequence: 1,
          type: "fixture.completed",
          payload: { fixture: true, verified: false },
        })
        .onConflictDoNothing({ target: [runEvents.ownerUserId, runEvents.runId, runEvents.sequence] });
      await tx
        .insert(sandboxes)
        .values({
          id: fixture.sandboxId,
          ownerUserId: owner.id,
          projectId: project.id,
          status: "stopped",
        })
        .onConflictDoNothing({ target: [sandboxes.ownerUserId, sandboxes.projectId] });
      const [reservation] = await tx
        .insert(usageReservations)
        .values({
          id: fixture.reservationId,
          ownerUserId: owner.id,
          projectId: project.id,
          idempotencyKey: `fixture-reservation-${fixture.clerkUserId}`,
          expiresAt: new Date("2040-01-01T00:00:00.000Z"),
          status: "committed",
        })
        .onConflictDoNothing({ target: [usageReservations.ownerUserId, usageReservations.idempotencyKey] })
        .returning({ id: usageReservations.id });
      const [existingReservation] = reservation
        ? [reservation]
        : await tx
            .select({ id: usageReservations.id })
            .from(usageReservations)
            .where(
              and(
                eq(usageReservations.ownerUserId, owner.id),
                eq(usageReservations.idempotencyKey, `fixture-reservation-${fixture.clerkUserId}`),
              ),
            )
            .limit(1);
      if (!existingReservation) throw new Error("No se pudo reconciliar la reserva fixture");
      await tx
        .insert(usageLedger)
        .values({
          ownerUserId: owner.id,
          projectId: project.id,
          reservationId: existingReservation.id,
          idempotencyKey: `fixture-ledger-${fixture.clerkUserId}`,
          kind: "charge",
          metadata: { fixture: true },
        })
        .onConflictDoNothing({ target: [usageLedger.ownerUserId, usageLedger.idempotencyKey] });
    });
    }
    console.log("Seed sintético idempotente aplicado: 2 usuarios y sus fixtures aislados.");
  } finally {
    await close();
  }
}

void main().catch(() => {
  console.error("No se pudo aplicar el seed sintético; revisa la base local y su estado de migración.");
  process.exitCode = 1;
});
