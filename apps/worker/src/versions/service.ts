import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  GameSpecSchema,
  SANDBOX_FILE_MAX_BYTES,
  type GameSpec,
} from "@meta-game/contracts";
import type { createRepositories, RunWorkerClaim, VerifiedIdentityContext } from "@meta-game/db";
import {
  createPrivateSnapshotStorage,
  snapshotBytes,
  type VersionSnapshot,
  type VersionSnapshotFile,
  type VersionSnapshotIdentity,
  type VersionSnapshotMetadata,
  type SnapshotLimits,
} from "@meta-game/storage";
import type { AgentSandbox } from "../agent/tools";
import { isSensitiveWorkspacePath, sensitiveWorkspaceContentReason } from "../agent/safety";

const BINARY_PATH = /^public\/assets\/.+\.(?:png|jpe?g|webp|gif|ico|mp3|ogg|wav|mp4|webm|wasm|woff2?|ttf|otf)$/i;
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".next", ".git", ".vite", "coverage", "test-results", "playwright-report", "tmp", "temp"]);
const MAX_FILE_COUNT = 512;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORIES = 512;
const SNAPSHOT_RECONCILIATION_AGE_MS = 30 * 60_000;
const versionSummarySchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid().nullable(),
  parentVersionId: z.string().uuid().nullable(),
  gameSpec: GameSpecSchema,
  verification: z.object({ status: z.literal("passed"), checks: z.array(z.object({ check: z.string(), status: z.literal("passed"), summary: z.string() }).strict()) }).strict(),
  files: z.array(z.object({ path: z.string(), encoding: z.enum(["utf8", "base64"]), bytes: z.number().int(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  totalBytes: z.number().int(),
  changes: z.object({ added: z.array(z.string()), modified: z.array(z.string()), removed: z.array(z.string()) }).strict(),
}).strict();

type VersionsRepository = ReturnType<typeof createRepositories>["versions"];
type VersionStorage = ReturnType<typeof createPrivateSnapshotStorage>;
type FileSource = Pick<AgentSandbox, "listFiles" | "readFile" | "readBinaryFile" | "writeFile" | "writeBinaryFile" | "deleteFile">;

class RestoreCommitUnknownError extends Error {
  constructor() { super("version_restore_commit_ambiguous"); this.name = "RestoreCommitUnknownError"; }
}

export function createVersionService(input: {
  versions: VersionsRepository;
  storage: VersionStorage & { close?: () => void };
  sandbox: FileSource;
  maxStorageBytes?: number;
}) {
  const snapshots = input.storage;
  const limits: SnapshotLimits = input.storage.limits;

  return {
    async captureLifecycleSnapshot(identity: VersionSnapshotIdentity, signal: AbortSignal) {
      const files = await captureWorkspaceFiles(input.sandbox, identity.projectId, signal, { requireProjectFiles: false }, limits);
      if (!files.length) return null;
      const specFile = files.find((file) => file.path === "src/game/project-spec.json" && file.encoding === "utf8");
      if (!specFile || specFile.encoding !== "utf8") throw new Error("lifecycle_snapshot_game_spec_missing");
      let gameSpec: GameSpec;
      try { gameSpec = GameSpecSchema.parse(JSON.parse(specFile.content)); }
      catch { throw new Error("lifecycle_snapshot_game_spec_invalid"); }
      const snapshot: VersionSnapshot = {
        schemaVersion: 1,
        projectId: identity.projectId,
        versionId: identity.versionId,
        runId: null,
        parentVersionId: null,
        gameSpec,
        verification: { status: "passed", checks: [{ check: "lifecycle_snapshot", status: "passed", summary: "Snapshot validado por manifiesto y checksum." }] },
        files,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      };
      const written = await snapshots.write(identity, snapshot);
      const verified = await snapshots.read(identity, written);
      if (!sameChecksums(snapshot.files, verified.files)) throw new Error("lifecycle_snapshot_verification_failed");
      return written;
    },

    async restoreLifecycleSnapshot(projectId: string, identity: VersionSnapshotIdentity, metadata: VersionSnapshotMetadata) {
      if (identity.projectId !== projectId) throw new Error("lifecycle_snapshot_identity_mismatch");
      const snapshot = await snapshots.read(identity, metadata);
      if (snapshot.projectId !== projectId || snapshot.versionId !== identity.versionId) throw new Error("lifecycle_snapshot_identity_mismatch");
      await applyFileSet(input.sandbox, projectId, snapshot.files, async () => undefined, limits);
      return { files: snapshot.files.length, bytes: snapshot.totalBytes };
    },

    async deleteLifecycleSnapshot(identity: VersionSnapshotIdentity) {
      await snapshots.delete(identity);
    },

    async deleteVersionSnapshot(identity: VersionSnapshotIdentity) {
      await snapshots.delete(identity);
    },

    async captureVerifiedRun(args: {
      identity: VerifiedIdentityContext;
      claim: RunWorkerClaim;
      gameSpec: GameSpec;
      checks: readonly { check: string; status: "passed" | "failed"; summary: string }[];
      signal: AbortSignal;
    }) {
      const verification = {
        status: "passed" as const,
        checks: args.checks.map(({ check, status, summary }) => ({ check, status, summary })),
      };
      if (!verification.checks.length || verification.checks.some((check) => check.status !== "passed")) {
        throw new Error("version_verification_report_invalid");
      }
      const files = await captureWorkspaceFiles(input.sandbox, args.claim.projectId, args.signal, {}, limits);
      const specFile = files.find((file) => file.path === "src/game/project-spec.json");
      if (!specFile || specFile.encoding !== "utf8") throw new Error("version_game_spec_missing");
      const storedSpec = GameSpecSchema.parse(JSON.parse(specFile.content));
      if (JSON.stringify(storedSpec) !== JSON.stringify(GameSpecSchema.parse(args.gameSpec))) throw new Error("version_game_spec_mismatch");
      for (const requiredPath of ["package.json", "package-lock.json", "public/assets/manifest.json"]) {
        if (!files.some((file) => file.path === requiredPath)) throw new Error("version_required_file_missing");
      }

      const identity = { ownerUserId: args.claim.ownerUserId, projectId: args.claim.projectId, versionId: args.claim.runId };
      const parent = await input.versions.latest(args.identity, args.claim.projectId);
      const versionId = args.claim.runId;
      const changes = compareFiles(parent?.manifest, files);
      const summary = makeSummary({
        runId: args.claim.runId,
        parentVersionId: parent?.id ?? null,
        gameSpec: args.gameSpec,
        verification,
        files,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
        changes,
      });
      const snapshot: VersionSnapshot = {
        schemaVersion: 1,
        projectId: args.claim.projectId,
        versionId,
        runId: args.claim.runId,
        parentVersionId: parent?.id ?? null,
        gameSpec: GameSpecSchema.parse(args.gameSpec),
        verification,
        files,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      };
      const body = snapshotBytes(snapshot);
      const sha256 = digest(body);
      try {
        const version = await input.versions.reserveForRun(args.identity, args.claim, {
          versionId,
          sha256,
          sizeBytes: body.byteLength,
          ...(input.maxStorageBytes ? { storageLimitBytes: input.maxStorageBytes } : {}),
          parentVersionId: parent?.id ?? null,
          manifest: summary as unknown as Record<string, unknown>,
        });
        if (version.status === "ready") return version;
        const stored = await snapshots.write(identity, snapshot);
        if (stored.sha256 !== sha256 || stored.sizeBytes !== body.byteLength) throw new Error("snapshot_checksum_mismatch");
        return await input.versions.markRunSnapshotReady(args.identity, args.claim, version.id);
      } catch (error) {
        let candidate: Awaited<ReturnType<typeof input.versions.getSnapshotCandidate>> | undefined;
        try {
          candidate = await input.versions.getSnapshotCandidate(args.identity, args.claim.projectId, versionId);
        } catch { /* Keep the reservation and object when SQL outcome is unknown. */ }
        if (candidate?.sha256 === sha256 && candidate.sizeBytes === body.byteLength && candidate.status === "ready") return candidate;
        if (candidate?.sha256 === sha256 && candidate.sizeBytes === body.byteLength && candidate.status === "creating") {
          let state: Awaited<ReturnType<typeof snapshots.inspectForReconciliation>>;
          try { state = await snapshots.inspectForReconciliation(identity, candidate); }
          catch { throw error; }
          if (state === "valid") {
            try { return await input.versions.markRunSnapshotReady(args.identity, args.claim, versionId); }
            catch { throw error; }
          }
          try {
            if (state === "invalid") await snapshots.delete(identity);
            await input.versions.markRunSnapshotFailed(args.identity, args.claim, versionId);
          } catch { /* The stale reservation is left for the automatic reconciler. */ }
        }
        throw error;
      }
    },

    async reconcilePendingSnapshots(options: { now?: number; limit?: number } = {}) {
      const now = options.now ?? Date.now();
      const limit = options.limit ?? 100;
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(limit) || limit < 1 || limit > 250) {
        throw new RangeError("Límites de reconciliación inválidos");
      }
      const cutoff = new Date(now - SNAPSHOT_RECONCILIATION_AGE_MS);
      const candidates = await input.versions.listSnapshotReconciliationCandidates(cutoff, limit);
      const result = { scanned: candidates.length, recovered: 0, failed: 0, deferred: 0 };
      for (const candidate of candidates) {
        const identity = { ownerUserId: candidate.ownerUserId, projectId: candidate.projectId, versionId: candidate.id };
        let state: Awaited<ReturnType<typeof snapshots.inspectForReconciliation>>;
        try {
          state = await snapshots.inspectForReconciliation(identity, candidate);
        } catch {
          result.deferred += 1;
          continue;
        }
        if (state === "invalid") {
          try { await snapshots.delete(identity); }
          catch { result.deferred += 1; continue; }
        }
        try {
          const changed = await input.versions.reconcileSnapshotCandidate({
            id: candidate.id,
            ownerUserId: candidate.ownerUserId,
            projectId: candidate.projectId,
            sha256: candidate.sha256,
            sizeBytes: candidate.sizeBytes,
            createdAt: candidate.createdAt,
            cutoff,
            status: state === "valid" ? "ready" : "failed",
          });
          if (changed) {
            if (state === "valid") result.recovered += 1;
            else result.failed += 1;
          }
        } catch {
          result.deferred += 1;
        }
      }
      return result;
    },

    async read(identity: VerifiedIdentityContext, projectId: string, versionId: string) {
      const version = await input.versions.get(identity, projectId, versionId);
      if (!version) return undefined;
      const owner = await input.versions.ownerId(identity, projectId);
      const snapshot = await snapshots.read({ ownerUserId: owner, projectId, versionId }, version);
      return { version, snapshot };
    },

    async restore(identity: VerifiedIdentityContext, projectId: string, versionId: string) {
      const source = await input.versions.get(identity, projectId, versionId);
      if (!source) return undefined;
      const ownerUserId = await input.versions.ownerId(identity, projectId);
      const lock = await input.versions.acquireRestoreLock(identity, projectId, 120_000);
      let heartbeatError: unknown;
      const heartbeat = setInterval(() => {
        void input.versions.renewRestoreLock(identity, lock).catch((error: unknown) => { heartbeatError = error; });
      }, 30_000);
      heartbeat.unref();
      let applyStarted = false;
      try {
        const sourceSnapshot = await snapshots.read({ ownerUserId, projectId, versionId }, source);
        const backupFiles = await captureWorkspaceFiles(input.sandbox, projectId, new AbortController().signal, { requireProjectFiles: false }, limits);
        const desired = sourceSnapshot.files;
        try {
          applyStarted = true;
          await applyFileSet(input.sandbox, projectId, desired, async () => {
            if (heartbeatError) throw new Error("version_restore_lock_lost");
            await input.versions.renewRestoreLock(identity, lock);
          }, limits);
          const restoredFiles = await captureWorkspaceFiles(input.sandbox, projectId, new AbortController().signal, {}, limits);
          if (!sameChecksums(desired, restoredFiles)) throw new Error("version_restore_checksum_mismatch");
          const newVersionId = randomUUID();
          const restoredSnapshot: VersionSnapshot = {
            ...sourceSnapshot,
            versionId: newVersionId,
            runId: null,
            parentVersionId: source.id,
            files: restoredFiles,
            totalBytes: restoredFiles.reduce((total, file) => total + file.bytes, 0),
          };
          const manifest = makeSummary({
            runId: null,
            parentVersionId: source.id,
            gameSpec: sourceSnapshot.gameSpec,
            verification: sourceSnapshot.verification,
            files: restoredFiles,
            totalBytes: restoredSnapshot.totalBytes,
            changes: compareFiles(source.manifest, restoredFiles),
          });
          const body = snapshotBytes(restoredSnapshot);
          const metadata = { sha256: digest(body), sizeBytes: body.byteLength };
          const newIdentity = { ownerUserId, projectId, versionId: newVersionId };
          let objectCreated = false;
          try {
            const reserved = await input.versions.createRestored(identity, lock, {
              versionId: newVersionId,
              projectId,
              ...metadata,
              ...(input.maxStorageBytes ? { storageLimitBytes: input.maxStorageBytes } : {}),
              parentVersionId: source.id,
              manifest: manifest as unknown as Record<string, unknown>,
            });
            const stored = await snapshots.write(newIdentity, restoredSnapshot);
            objectCreated = stored.created;
            if (stored.sha256 !== metadata.sha256 || stored.sizeBytes !== metadata.sizeBytes) throw new Error("snapshot_checksum_mismatch");
            const version = await input.versions.markRestoredSnapshotReady(identity, lock, reserved.id);
            return { versionId: newVersionId, versionNumber: version.versionNumber };
          } catch (error) {
            let candidate: Awaited<ReturnType<typeof input.versions.getSnapshotCandidate>> | undefined;
            let lookupSucceeded = false;
            try {
              candidate = await input.versions.getSnapshotCandidate(identity, projectId, newVersionId);
              lookupSucceeded = true;
            } catch { /* Preserve the object and applied files until SQL can be reconciled. */ }
            if (candidate) {
              if (candidate.sha256 !== metadata.sha256 || candidate.sizeBytes !== metadata.sizeBytes) throw new RestoreCommitUnknownError();
              if (candidate.status === "ready") return { versionId: newVersionId, versionNumber: candidate.versionNumber };
              if (candidate.status === "creating") {
                let state: Awaited<ReturnType<typeof snapshots.inspectForReconciliation>>;
                try { state = await snapshots.inspectForReconciliation(newIdentity, candidate); }
                catch { throw new RestoreCommitUnknownError(); }
                if (state === "valid") {
                  try {
                    const version = await input.versions.markRestoredSnapshotReady(identity, lock, newVersionId);
                    return { versionId: newVersionId, versionNumber: version.versionNumber };
                  } catch { throw new RestoreCommitUnknownError(); }
                }
                const cutoff = new Date(Math.max(Date.now(), candidate.createdAt.getTime()) + 1);
                if (state === "invalid") {
                  try { await snapshots.delete(newIdentity); }
                  catch { throw new RestoreCommitUnknownError(); }
                }
                const failed = await input.versions.reconcileSnapshotCandidate({
                  id: candidate.id,
                  ownerUserId: candidate.ownerUserId,
                  projectId: candidate.projectId,
                  sha256: candidate.sha256,
                  sizeBytes: candidate.sizeBytes,
                  createdAt: candidate.createdAt,
                  cutoff,
                  status: "failed",
                });
                if (!failed && state === "invalid") throw new RestoreCommitUnknownError();
                throw error;
              }
            }
            if (!lookupSucceeded) throw new RestoreCommitUnknownError();
            if (objectCreated) await snapshots.delete(newIdentity).catch(() => undefined);
            throw error;
          }
        } catch (error) {
          if (error instanceof RestoreCommitUnknownError) throw error;
          if (applyStarted) await applyFileSet(input.sandbox, projectId, backupFiles, async () => {
            if (heartbeatError) throw new Error("version_restore_lock_lost");
            await input.versions.renewRestoreLock(identity, lock);
          }, limits).catch(() => { throw new Error("version_restore_rollback_failed"); });
          throw error;
        }
      } finally {
        clearInterval(heartbeat);
        await input.versions.releaseRestoreLock(identity, lock).catch(() => undefined);
      }
    },

    close() { input.storage.close?.(); },
  };
}

async function captureWorkspaceFiles(
  sandbox: FileSource,
  projectId: string,
  signal: AbortSignal,
  options: { requireProjectFiles?: boolean } = {},
  limits: SnapshotLimits = { maxFiles: MAX_FILE_COUNT, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxArchiveBytes: 25 * 1024 * 1024 },
): Promise<VersionSnapshotFile[]> {
  const files: VersionSnapshotFile[] = [];
  const queue = [""];
  let directoryCount = 0;
  let totalBytes = 0;
  while (queue.length) {
    const directory = queue.shift()!;
    if (++directoryCount > MAX_DIRECTORIES) throw new Error("version_directory_limit");
    const listing = await sandbox.listFiles(projectId, directory, signal);
    if (listing.files.length > 32) throw new Error("version_directory_limit");
    for (const entry of listing.files) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.type === "directory") {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) queue.push(path);
        continue;
      }
      if (isSensitiveWorkspacePath(path)) continue;
      if (files.length >= limits.maxFiles) throw new Error("version_file_limit");
      let file: VersionSnapshotFile;
      if (BINARY_PATH.test(path)) {
        const bytes = await sandbox.readBinaryFile(projectId, path, signal);
        if (bytes.byteLength > limits.maxFileBytes) throw new Error("version_file_size_limit");
        file = { path, encoding: "base64", content: Buffer.from(bytes).toString("base64"), bytes: bytes.byteLength, sha256: digest(bytes) };
      } else {
        let result: { content: string };
        try { result = await sandbox.readFile(projectId, path, signal); }
        catch (error) {
          const code = error instanceof Error && "code" in error ? (error as Error & { code?: unknown }).code : undefined;
          if (code === "file_not_utf8") continue;
          throw error;
        }
        if (sensitiveWorkspaceContentReason(path, result.content)) throw new Error("version_sensitive_content_blocked");
        const bytes = Buffer.byteLength(result.content, "utf8");
        if (bytes > Math.min(SANDBOX_FILE_MAX_BYTES, limits.maxFileBytes)) throw new Error("version_file_size_limit");
        file = { path, encoding: "utf8", content: result.content, bytes, sha256: digest(result.content) };
      }
      totalBytes += file.bytes;
      if (totalBytes > limits.maxTotalBytes) throw new Error("version_snapshot_size_limit");
      files.push(file);
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (options.requireProjectFiles !== false) {
    for (const path of ["package.json", "package-lock.json", "src/game/project-spec.json", "public/assets/manifest.json"]) {
      if (!files.some((file) => file.path === path)) throw new Error("version_required_file_missing");
    }
  }
  return files;
}

async function applyFileSet(
  sandbox: FileSource,
  projectId: string,
  target: readonly VersionSnapshotFile[],
  beforeOperation: () => Promise<void>,
  limits: SnapshotLimits,
) {
  const current = await captureWorkspaceFiles(sandbox, projectId, new AbortController().signal, { requireProjectFiles: false }, limits);
  const targetPaths = new Set(target.map((file) => file.path));
  for (const file of current) {
    if (targetPaths.has(file.path)) continue;
    await beforeOperation();
    await sandbox.deleteFile(projectId, file.path);
  }
  for (const file of target) {
    await beforeOperation();
    const result = file.encoding === "utf8"
      ? await sandbox.writeFile(projectId, file.path, file.content)
      : await sandbox.writeBinaryFile(projectId, file.path, Buffer.from(file.content, "base64"));
    if (result.bytesWritten !== file.bytes) throw new Error("version_restore_write_incomplete");
  }
  const actual = await captureWorkspaceFiles(sandbox, projectId, new AbortController().signal, { requireProjectFiles: false }, limits);
  if (!sameChecksums(target, actual)) throw new Error("version_restore_checksum_mismatch");
}

function compareFiles(parentManifest: unknown, files: readonly VersionSnapshotFile[]) {
  const parentParsed = z.object({ files: z.array(z.object({ path: z.string(), sha256: z.string() }).passthrough()).optional() }).passthrough().safeParse(parentManifest);
  const prior = new Map((parentParsed.success ? parentParsed.data.files ?? [] : []).map((file) => [file.path, file.sha256]));
  const current = new Map(files.map((file) => [file.path, file.sha256]));
  return {
    added: [...current.keys()].filter((path) => !prior.has(path)).sort(),
    modified: [...current.keys()].filter((path) => prior.has(path) && prior.get(path) !== current.get(path)).sort(),
    removed: [...prior.keys()].filter((path) => !current.has(path)).sort(),
  };
}

function makeSummary(input: {
  runId: string | null;
  parentVersionId: string | null;
  gameSpec: GameSpec;
  verification: { status: "passed"; checks: readonly { check: string; status: "passed" | "failed"; summary: string }[] };
  files: readonly VersionSnapshotFile[];
  totalBytes: number;
  changes: { added: string[]; modified: string[]; removed: string[] };
}) {
  return versionSummarySchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    parentVersionId: input.parentVersionId,
    gameSpec: input.gameSpec,
    verification: { status: "passed", checks: input.verification.checks.filter((check) => check.status === "passed") },
    files: input.files.map(({ path, encoding, bytes, sha256 }) => ({ path, encoding, bytes, sha256 })),
    totalBytes: input.totalBytes,
    changes: input.changes,
  });
}

function sameChecksums(expected: readonly VersionSnapshotFile[], actual: readonly VersionSnapshotFile[]) {
  if (expected.length !== actual.length) return false;
  const actualMap = new Map(actual.map((file) => [file.path, file.sha256]));
  return expected.every((file) => actualMap.get(file.path) === file.sha256);
}

function digest(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}
