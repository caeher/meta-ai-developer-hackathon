import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { GameSpecSchema, SANDBOX_FILE_MAX_BYTES } from "@meta-game/contracts";
import { PrivateStorageError, createS3PrivateObjectClient, readStorageEnvironment, type PrivateObjectClient } from "./index.js";

const UUID = z.string().uuid();
const MAX_FILE_COUNT = 512;
const MAX_BINARY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const EXCLUDED_SEGMENTS = new Set(["node_modules", "dist", ".next", ".git", ".vite", "coverage", "test-results", "playwright-report", "tmp", "temp"]);
const secretFilename = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.git-credentials|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i;
const safeRelativePath = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,512}$/;

const snapshotFileSchema = z.object({
  path: z.string().regex(safeRelativePath),
  encoding: z.enum(["utf8", "base64"]),
  content: z.string().max(MAX_BINARY_FILE_BYTES * 4 / 3 + 8),
  bytes: z.number().int().nonnegative().max(MAX_BINARY_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const verificationCheckSchema = z.object({
  check: z.string().trim().min(1).max(80),
  status: z.enum(["passed", "failed"]),
  summary: z.string().trim().min(1).max(500),
}).strict();

export const VersionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: UUID,
  versionId: UUID,
  runId: UUID.nullable(),
  parentVersionId: UUID.nullable(),
  gameSpec: GameSpecSchema,
  verification: z.object({ status: z.literal("passed"), checks: z.array(verificationCheckSchema).max(32) }).strict(),
  files: z.array(snapshotFileSchema).min(1).max(MAX_FILE_COUNT),
  totalBytes: z.number().int().positive().max(MAX_TOTAL_FILE_BYTES),
}).strict().superRefine((snapshot, context) => {
  let total = 0;
  const paths = new Set<string>();
  for (const [index, file] of snapshot.files.entries()) {
    const segments = file.path.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || EXCLUDED_SEGMENTS.has(segment.toLowerCase())) || secretFilename.test(file.path)) {
      context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Sensitive or generated files cannot be snapshotted" });
    }
    if (paths.has(file.path)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Snapshot paths must be unique" });
    paths.add(file.path);
    const decoded = file.encoding === "base64" ? strictBase64(file.content) : undefined;
    const bytes = file.encoding === "base64" ? decoded?.byteLength : Buffer.byteLength(file.content, "utf8");
    const digest = file.encoding === "base64" ? (decoded ? sha256(decoded) : undefined) : sha256(file.content);
    const maxFileBytes = file.encoding === "utf8" ? SANDBOX_FILE_MAX_BYTES : MAX_BINARY_FILE_BYTES;
    if (bytes === undefined || bytes !== file.bytes || bytes > maxFileBytes || digest !== file.sha256) {
      context.addIssue({ code: "custom", path: ["files", index], message: "Snapshot file checksum or size is invalid" });
    }
    total += bytes ?? 0;
    if (total > MAX_TOTAL_FILE_BYTES) {
      context.addIssue({ code: "custom", path: ["totalBytes"], message: "Snapshot exceeds the expanded size limit" });
      break;
    }
  }
  if (total !== snapshot.totalBytes) context.addIssue({ code: "custom", path: ["totalBytes"], message: "Snapshot total size does not match its files" });
});

export type VersionSnapshot = z.infer<typeof VersionSnapshotSchema>;
export type VersionSnapshotFile = VersionSnapshot["files"][number];
export type VersionSnapshotIdentity = Readonly<{ ownerUserId: string; projectId: string; versionId: string }>;
export type VersionSnapshotMetadata = Readonly<{ sha256: string; sizeBytes: number }>;
export type VersionSnapshotWriteResult = VersionSnapshotMetadata & Readonly<{ created: boolean }>;
export type SnapshotLimits = Readonly<{ maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxArchiveBytes: number }>;
const snapshotLimitsSchema = z.object({
  maxFiles: z.number().int().min(1).max(MAX_FILE_COUNT).default(MAX_FILE_COUNT),
  maxFileBytes: z.number().int().min(1).max(MAX_BINARY_FILE_BYTES).default(MAX_BINARY_FILE_BYTES),
  maxTotalBytes: z.number().int().min(1).max(MAX_TOTAL_FILE_BYTES).default(MAX_TOTAL_FILE_BYTES),
  maxArchiveBytes: z.number().int().min(1).max(MAX_ARCHIVE_BYTES).default(MAX_ARCHIVE_BYTES),
}).strict();
const snapshotEnvironmentSchema = z.object({
  SNAPSHOT_MAX_FILES: z.coerce.number().int().min(1).max(MAX_FILE_COUNT).default(MAX_FILE_COUNT),
  SNAPSHOT_MAX_FILE_BYTES: z.coerce.number().int().min(1).max(MAX_BINARY_FILE_BYTES).default(MAX_BINARY_FILE_BYTES),
  SNAPSHOT_MAX_TOTAL_BYTES: z.coerce.number().int().min(1).max(MAX_TOTAL_FILE_BYTES).default(MAX_TOTAL_FILE_BYTES),
  SNAPSHOT_MAX_ARCHIVE_BYTES: z.coerce.number().int().min(1).max(MAX_ARCHIVE_BYTES).default(MAX_ARCHIVE_BYTES),
}).strict();

export function readSnapshotEnvironment(source: NodeJS.ProcessEnv = process.env): SnapshotLimits {
  const parsed = snapshotEnvironmentSchema.safeParse({
    SNAPSHOT_MAX_FILES: source.SNAPSHOT_MAX_FILES,
    SNAPSHOT_MAX_FILE_BYTES: source.SNAPSHOT_MAX_FILE_BYTES,
    SNAPSHOT_MAX_TOTAL_BYTES: source.SNAPSHOT_MAX_TOTAL_BYTES,
    SNAPSHOT_MAX_ARCHIVE_BYTES: source.SNAPSHOT_MAX_ARCHIVE_BYTES,
  });
  if (!parsed.success) throw new Error("Configuración de límites de snapshot inválida.");
  return {
    maxFiles: parsed.data.SNAPSHOT_MAX_FILES,
    maxFileBytes: parsed.data.SNAPSHOT_MAX_FILE_BYTES,
    maxTotalBytes: parsed.data.SNAPSHOT_MAX_TOTAL_BYTES,
    maxArchiveBytes: parsed.data.SNAPSHOT_MAX_ARCHIVE_BYTES,
  };
}

export function snapshotObjectKey(identity: VersionSnapshotIdentity): string {
  const parsed = z.object({ ownerUserId: UUID, projectId: UUID, versionId: UUID }).strict().parse(identity);
  return `private/${parsed.ownerUserId}/projects/${parsed.projectId}/versions/${parsed.versionId}`;
}

export function snapshotBytes(snapshot: VersionSnapshot): Uint8Array {
  const parsed = VersionSnapshotSchema.parse(snapshot);
  const bytes = gzipSync(Buffer.from(JSON.stringify(parsed), "utf8"), { level: 6 });
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ARCHIVE_BYTES) throw new RangeError("Snapshot comprimido fuera del límite");
  return bytes;
}

export function decodeVersionSnapshot(body: Uint8Array): VersionSnapshot {
  if (!(body instanceof Uint8Array) || body.byteLength < 1 || body.byteLength > MAX_ARCHIVE_BYTES) throw new TypeError("El snapshot comprimido no es válido");
  let decoded: Buffer;
  try { decoded = gunzipSync(body, { maxOutputLength: MAX_EXPANDED_BYTES }); }
  catch { throw new TypeError("El snapshot excede el límite expandido o está dañado"); }
  let candidate: unknown;
  try { candidate = JSON.parse(decoded.toString("utf8")); }
  catch { throw new TypeError("El manifiesto del snapshot no es JSON válido"); }
  const parsed = VersionSnapshotSchema.safeParse(candidate);
  if (!parsed.success) throw new TypeError("El manifiesto del snapshot no cumple el contrato");
  return parsed.data;
}

export function createPrivateSnapshotStorage(client: PrivateObjectClient, limitsInput: number | Partial<SnapshotLimits> = {}) {
  const limits = snapshotLimitsSchema.parse(typeof limitsInput === "number" ? { maxArchiveBytes: limitsInput } : limitsInput);
  return {
    limits,
    async write(identity: VersionSnapshotIdentity, snapshot: VersionSnapshot): Promise<VersionSnapshotWriteResult> {
      const key = snapshotObjectKey(identity);
      const parsed = VersionSnapshotSchema.parse(snapshot);
      if (parsed.projectId !== identity.projectId || parsed.versionId !== identity.versionId) throw new TypeError("La identidad del snapshot no coincide");
      assertWithinSnapshotLimits(parsed, limits);
      const body = snapshotBytes(parsed);
      if (body.byteLength > limits.maxArchiveBytes) throw new RangeError("El snapshot supera el límite configurado");
      const sha = sha256(body);
      let created = false;
      try {
        try {
          await client.put({ key, body, contentType: "application/gzip", sha256: sha, ifAbsent: true });
          created = true;
        } catch {
          const existing = await client.head(key);
          if (existing.sizeBytes !== body.byteLength || existing.sha256 !== sha) throw new Error("snapshot_immutable");
          const existingBody = await client.get(key);
          if (existingBody.byteLength !== body.byteLength || sha256(existingBody) !== sha) throw new Error("snapshot_immutable");
        }
        const stored = await client.head(key);
        if (stored.sizeBytes !== body.byteLength || stored.sha256 !== sha) throw new Error("snapshot_checksum_mismatch");
      } catch { throw new PrivateStorageError("No se pudo guardar y verificar el snapshot privado"); }
      return { sha256: sha, sizeBytes: body.byteLength, created };
    },

    async read(identity: VersionSnapshotIdentity, expected: VersionSnapshotMetadata): Promise<VersionSnapshot> {
      const key = snapshotObjectKey(identity);
      if (!/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 1 || expected.sizeBytes > limits.maxArchiveBytes) throw new TypeError("Metadata de snapshot inválida");
      try {
        const stored = await client.head(key);
        if (stored.sizeBytes !== expected.sizeBytes || stored.sha256 !== expected.sha256) throw new Error("snapshot_metadata_mismatch");
        const body = await client.get(key);
        if (body.byteLength !== expected.sizeBytes || sha256(body) !== expected.sha256) throw new Error("snapshot_checksum_mismatch");
        const snapshot = decodeVersionSnapshot(body);
        if (snapshot.projectId !== identity.projectId || snapshot.versionId !== identity.versionId) throw new Error("snapshot_identity_mismatch");
        assertWithinSnapshotLimits(snapshot, limits);
        return snapshot;
      } catch { throw new PrivateStorageError("No se pudo leer y verificar el snapshot privado"); }
    },

    async delete(identity: VersionSnapshotIdentity): Promise<void> {
      try { await client.delete(snapshotObjectKey(identity)); }
      catch { throw new PrivateStorageError("No se pudo eliminar el snapshot privado"); }
    },
  };
}

export function createPrivateSnapshotStorageFromEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const config = readStorageEnvironment(source);
  const limits = readSnapshotEnvironment(source);
  const client = createS3PrivateObjectClient(config);
  return { ...createPrivateSnapshotStorage(client, limits), close: () => client.close?.() };
}

function assertWithinSnapshotLimits(snapshot: VersionSnapshot, limits: SnapshotLimits): void {
  if (snapshot.files.length > limits.maxFiles || snapshot.totalBytes > limits.maxTotalBytes || snapshot.files.some((file) => file.bytes > limits.maxFileBytes)) {
    throw new RangeError("El snapshot supera los límites configurados");
  }
}

function strictBase64(value: string): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
