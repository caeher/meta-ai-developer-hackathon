import type { GameDatabase, SandboxRecord, SandboxState } from "@meta-game/db";
import {
  claimExpiredSandboxes,
  claimProjectDevServerStart,
  createOrGetProjectSandbox,
  getProjectSandbox,
  getProjectSandboxForCleanup,
  touchProjectSandbox,
  updateProjectSandbox,
} from "@meta-game/db";

export interface SandboxRegistry {
  createOrGet(projectId: string): Promise<SandboxRecord>;
  get(projectId: string): Promise<SandboxRecord | undefined>;
  getForCleanup(projectId: string): Promise<SandboxRecord | undefined>;
  update(record: SandboxRecord, patch: {
    status: SandboxState;
    runtimeId?: string | null;
    leaseExpiresAt?: Date | null;
    devServerStatus?: SandboxRecord["devServerStatus"];
    devServerPort?: number | null;
    devServerLeaseExpiresAt?: Date | null;
    lifecycleLeaseToken?: string | null;
    lifecycleLeaseExpiresAt?: Date | null;
    lifecycleSnapshotId?: string | null;
    lifecycleSnapshotSha256?: string | null;
    lifecycleSnapshotSizeBytes?: number | null;
  }): Promise<void>;
  touch(record: SandboxRecord, leaseExpiresAt: Date): Promise<boolean>;
  claimDevServerStart(record: SandboxRecord, input: { port: number; serverLeaseExpiresAt: Date; sandboxLeaseExpiresAt: Date }): Promise<boolean>;
  claimExpired(limit?: number): Promise<SandboxRecord[]>;
}

export function createSandboxRegistry(database: GameDatabase): SandboxRegistry {
  return {
    createOrGet: (projectId) => createOrGetProjectSandbox(database, projectId),
    get: (projectId) => getProjectSandbox(database, projectId),
    getForCleanup: (projectId) => getProjectSandboxForCleanup(database, projectId),
    update: (record, patch) => updateProjectSandbox(database, record, patch),
    touch: (record, expiresAt) => touchProjectSandbox(database, record, expiresAt),
    claimDevServerStart: (record, input) => claimProjectDevServerStart(database, record, input),
    claimExpired: (limit) => claimExpiredSandboxes(database, limit),
  };
}
