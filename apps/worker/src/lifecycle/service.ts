import { randomUUID } from "node:crypto";
import {
  beginSandboxSuspension,
  claimDeletedProjectSandboxes,
  claimIdleSandboxes,
  claimProjectCleanupBatch,
  clearSandboxLifecycleSnapshot,
  completeProjectCleanup,
  failProjectCleanup,
  finishSandboxSuspension,
  getProjectCleanupResources,
  getProjectSandbox,
  releaseSandboxLifecycleLease,
  releaseDeletedProjectSandboxLease,
  type GameDatabase,
} from "@meta-game/db";
import type { SandboxControllerClient } from "@meta-game/sandbox";

type LifecycleSnapshots = Readonly<{
  captureLifecycleSnapshot(identity: { ownerUserId: string; projectId: string; versionId: string }, signal: AbortSignal): Promise<{ sha256: string; sizeBytes: number } | null>;
  restoreLifecycleSnapshot(projectId: string, identity: { ownerUserId: string; projectId: string; versionId: string }, metadata: { sha256: string; sizeBytes: number }): Promise<{ files: number; bytes: number }>;
  deleteLifecycleSnapshot(identity: { ownerUserId: string; projectId: string; versionId: string }): Promise<void>;
  deleteVersionSnapshot(identity: { ownerUserId: string; projectId: string; versionId: string }): Promise<void>;
}>;

type CleanupStorage = Readonly<{ delete(key: string): Promise<void> }>;
type CheckpointCleanup = Readonly<{ delete(identity: { ownerUserId: string; projectId: string; runId: string }): Promise<void> }>;
type PublicationCleanup = Readonly<{ delete(slug: string): Promise<void> }>;
type RunJobCleanup = Readonly<{ removeProjectRuns(jobs: readonly { runId: string; generation: number }[]): Promise<void> }>;

export function createResourceLifecycleService(input: {
  database: GameDatabase;
  sandbox: SandboxControllerClient;
  snapshots: LifecycleSnapshots;
  idleTtlSeconds: number;
  activeConnectionGraceSeconds?: number;
  retentionDays: number;
  maxStorageBytes: number;
  privateObjects: CleanupStorage;
  checkpoints: CheckpointCleanup;
  jobs: RunJobCleanup;
  hasActivePreview?: (projectId: string) => Promise<boolean>;
  publications?: PublicationCleanup;
}) {
  if (!Number.isSafeInteger(input.idleTtlSeconds) || input.idleTtlSeconds < 60 || input.idleTtlSeconds > 86_400) {
    throw new RangeError("Invalid sandbox idle TTL");
  }

  return {
    async reapDeletedSandboxes(options: { now?: Date; limit?: number } = {}) {
      const records = await claimDeletedProjectSandboxes(input.database, { now: options.now, limit: options.limit ?? 25, leaseMs: 120_000 });
      const result = { scanned: records.length, quiesced: 0, failed: 0 };
      for (const record of records) {
        try {
          await input.sandbox.quiesceManagedProject(record.projectId);
          result.quiesced += 1;
        } catch {
          await releaseDeletedProjectSandboxLease(input.database, record, record.lifecycleLeaseToken!).catch(() => undefined);
          result.failed += 1;
        }
      }
      return result;
    },

    async suspendExpired(options: { now?: Date; limit?: number } = {}) {
      const now = options.now ?? new Date();
      const records = await claimIdleSandboxes(input.database, {
        now, limit: options.limit ?? 25, leaseMs: 120_000, graceSeconds: input.activeConnectionGraceSeconds ?? 0,
      });
      const result = { scanned: records.length, suspended: 0, preserved: 0, failed: 0 };
      for (const record of records) {
        const snapshotId = randomUUID();
        let metadata: { sha256: string; sizeBytes: number } | null = null;
        let suspensionStarted = false;
        const identity = { ownerUserId: record.ownerUserId, projectId: record.projectId, versionId: snapshotId };
        try {
          if (record.status === "suspending") {
            suspensionStarted = true;
            await input.sandbox.destroy(record.projectId);
            if (!await finishSandboxSuspension(input.database, record, record.lifecycleLeaseToken!)) {
              throw new Error("sandbox_suspension_commit_lost");
            }
            result.suspended += 1;
            continue;
          }
          const current = await input.sandbox.inspect(record.projectId);
          if (current.state !== "ready") throw new Error("sandbox_not_ready_for_suspension");
          if (await input.hasActivePreview?.(record.projectId)) {
            await releaseSandboxLifecycleLease(input.database, record, record.lifecycleLeaseToken!, input.idleTtlSeconds);
            result.preserved += 1;
            continue;
          }
          metadata = await input.snapshots.captureLifecycleSnapshot(identity, new AbortController().signal);
          const committed = await beginSandboxSuspension(input.database, {
            record,
            leaseToken: record.lifecycleLeaseToken!,
            snapshot: metadata ? { id: snapshotId, ...metadata } : null,
            maxStorageBytes: input.maxStorageBytes,
            now,
          });
          if (!committed) {
            if (metadata) await input.snapshots.deleteLifecycleSnapshot(identity).catch(() => undefined);
            await releaseSandboxLifecycleLease(input.database, record, record.lifecycleLeaseToken!, input.idleTtlSeconds);
            result.preserved += 1;
            continue;
          }
          suspensionStarted = true;
          await input.sandbox.destroy(record.projectId);
          if (!await finishSandboxSuspension(input.database, record, record.lifecycleLeaseToken!)) {
            throw new Error("sandbox_suspension_commit_lost");
          }
          result.suspended += 1;
        } catch {
          if (!suspensionStarted) {
            if (metadata) await input.snapshots.deleteLifecycleSnapshot(identity).catch(() => undefined);
            await releaseSandboxLifecycleLease(input.database, record, record.lifecycleLeaseToken!, input.idleTtlSeconds).catch(() => undefined);
          }
          result.failed += 1;
        }
      }
      return result;
    },

    async restoreSuspended(projectId: string) {
      const record = await getProjectSandbox(input.database, projectId);
      if (!record || record.status !== "ready" || !record.lifecycleSnapshotId) return { restored: false };
      const snapshot = {
        ownerUserId: record.ownerUserId,
        projectId: record.projectId,
        versionId: record.lifecycleSnapshotId,
      };
      const metadata = { sha256: record.lifecycleSnapshotSha256!, sizeBytes: record.lifecycleSnapshotSizeBytes! };
      await input.snapshots.restoreLifecycleSnapshot(projectId, snapshot, metadata);
      if (!await clearSandboxLifecycleSnapshot(input.database, record, record.lifecycleSnapshotId)) {
        throw new Error("sandbox_lifecycle_snapshot_clear_failed");
      }
      await input.snapshots.deleteLifecycleSnapshot(snapshot).catch(() => undefined);
      return { restored: true };
    },

    async reconcileDeletedProjects(options: { now?: Date; limit?: number } = {}) {
      const tasks = await claimProjectCleanupBatch(input.database, {
        now: options.now,
        limit: options.limit ?? 25,
        retentionDays: input.retentionDays,
      });
      const result = { scanned: tasks.length, completed: 0, failed: 0 };
      for (const task of tasks) {
        try {
          const resources = await getProjectCleanupResources(input.database, task);
          if (!resources) throw new Error("project_cleanup_lease_lost");
          await input.jobs.removeProjectRuns(resources.runJobs);
          if (resources.sandbox) await input.sandbox.cleanupManagedProject(task.projectId);
          if (resources.sandbox?.lifecycleSnapshotId) {
            await input.snapshots.deleteLifecycleSnapshot({
              ownerUserId: task.ownerUserId, projectId: task.projectId,
              versionId: resources.sandbox.lifecycleSnapshotId,
            });
          }
          for (const asset of resources.assets) await input.privateObjects.delete(asset.objectKey);
          for (const version of resources.versions) await input.snapshots.deleteVersionSnapshot({
            ownerUserId: task.ownerUserId, projectId: task.projectId, versionId: version.id,
          });
          for (const runId of resources.runIds) await input.checkpoints.delete({
            ownerUserId: task.ownerUserId, projectId: task.projectId, runId,
          });
          if (resources.publications.length && !input.publications) throw new Error("publication_storage_cleanup_unavailable");
          for (const publication of resources.publications) await input.publications!.delete(publication.slug);
          if (!await completeProjectCleanup(input.database, task)) throw new Error("project_cleanup_lease_lost");
          result.completed += 1;
        } catch (error) {
          const code = error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message)
            ? error.message
            : "resource_cleanup_failed";
          await failProjectCleanup(input.database, task, code).catch(() => undefined);
          result.failed += 1;
        }
      }
      return result;
    },
  };
}
