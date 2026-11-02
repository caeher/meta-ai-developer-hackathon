import type { GameDatabase, SandboxRecord, SandboxState } from "@meta-game/db";
import {
  claimExpiredSandboxes,
  createOrGetProjectSandbox,
  getProjectSandbox,
  touchProjectSandbox,
  updateProjectSandbox,
} from "@meta-game/db";

export interface SandboxRegistry {
  createOrGet(projectId: string): Promise<SandboxRecord>;
  get(projectId: string): Promise<SandboxRecord | undefined>;
  update(record: SandboxRecord, patch: { status: SandboxState; runtimeId?: string | null; leaseExpiresAt?: Date | null }): Promise<void>;
  touch(record: SandboxRecord, leaseExpiresAt: Date): Promise<boolean>;
  claimExpired(limit?: number): Promise<SandboxRecord[]>;
}

export function createSandboxRegistry(database: GameDatabase): SandboxRegistry {
  return {
    createOrGet: (projectId) => createOrGetProjectSandbox(database, projectId),
    get: (projectId) => getProjectSandbox(database, projectId),
    update: (record, patch) => updateProjectSandbox(database, record, patch),
    touch: (record, expiresAt) => touchProjectSandbox(database, record, expiresAt),
    claimExpired: (limit) => claimExpiredSandboxes(database, limit),
  };
}
