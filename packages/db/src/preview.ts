import { and, eq, gt, isNull } from "drizzle-orm";
import { SANDBOX_DEV_SERVER_PORT } from "@meta-game/contracts";
import type { GameDatabase } from "./database";
import { projects, sandboxes, users } from "./schema/index";

export type PreviewTarget = Readonly<{
  ownerUserId: string;
  projectId: string;
  sandboxId: string;
  devServerPort: number;
  leaseExpiresAt: Date;
}>;

/** Resolves only active, leased projects with the fixed Vite port registered as ready. */
export async function getPreviewTarget(database: GameDatabase, projectId: string): Promise<PreviewTarget | undefined> {
  const now = new Date();
  const [row] = await database.select({
    ownerUserId: users.userId,
    projectId: projects.id,
    sandboxId: sandboxes.id,
    sandboxStatus: sandboxes.status,
    sandboxLease: sandboxes.leaseExpiresAt,
    devServerStatus: sandboxes.devServerStatus,
    devServerPort: sandboxes.devServerPort,
    devServerLease: sandboxes.devServerLeaseExpiresAt,
  }).from(sandboxes)
    .innerJoin(projects, and(
      eq(projects.id, sandboxes.projectId),
      eq(projects.ownerUserId, sandboxes.ownerUserId),
      isNull(projects.deletedAt),
    ))
    .innerJoin(users, eq(users.id, projects.ownerUserId))
    .where(and(
      eq(sandboxes.projectId, projectId),
      eq(sandboxes.status, "ready"),
      gt(sandboxes.leaseExpiresAt, now),
      eq(sandboxes.devServerStatus, "ready"),
      eq(sandboxes.devServerPort, SANDBOX_DEV_SERVER_PORT),
      gt(sandboxes.devServerLeaseExpiresAt, now),
    )).limit(1);

  if (!row?.sandboxLease || !row.devServerLease || row.devServerPort !== SANDBOX_DEV_SERVER_PORT) return undefined;
  return {
    ownerUserId: row.ownerUserId,
    projectId: row.projectId,
    sandboxId: row.sandboxId,
    devServerPort: row.devServerPort,
    leaseExpiresAt: row.devServerLease,
  };
}
