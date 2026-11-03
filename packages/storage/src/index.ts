import { createHash } from "node:crypto";
import {
  IdempotencyConflictError,
  OwnedResourceNotFoundError,
  type VerifiedIdentityContext,
} from "@meta-game/db";
import {
  createS3PrivateObjectClient,
  MAX_PRIVATE_OBJECT_BYTES,
  PrivateStorageError,
  readStorageEnvironment,
  type PrivateObjectClient,
} from "./private-objects";

export { createS3PrivateObjectClient, PrivateStorageError, readStorageEnvironment };
export type { PrivateObjectClient };

const MAX_OBJECT_BYTES = MAX_PRIVATE_OBJECT_BYTES;
const allowedContentTypes = new Set([
  "application/json",
  "application/octet-stream",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type StorageAsset = {
  id: string;
  ownerUserId: string;
  projectId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  metadata?: Record<string, unknown>;
  status: "pending" | "ready" | "delete_requested" | "failed";
  createdAt: Date;
  updatedAt: Date;
};

export interface AssetRepository {
  createPending(
    identity: VerifiedIdentityContext,
    input: { assetId?: string; projectId: string; contentType: string; sizeBytes: number; sha256: string; metadata?: Record<string, unknown> },
  ): Promise<StorageAsset>;
  getReady(identity: VerifiedIdentityContext, assetId: string): Promise<StorageAsset | undefined>;
  completeUpload(
    identity: VerifiedIdentityContext,
    assetId: string,
    checksum: string,
    sizeBytes: number,
  ): Promise<StorageAsset>;
  markFailed(identity: VerifiedIdentityContext, assetId: string): Promise<StorageAsset>;
  requestDelete(identity: VerifiedIdentityContext, assetId: string): Promise<StorageAsset>;
  finishDelete(identity: VerifiedIdentityContext, assetId: string): Promise<{ id: string }>;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function publicAsset(asset: StorageAsset) {
  return {
    id: asset.id,
    projectId: asset.projectId,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    status: asset.status,
    createdAt: asset.createdAt,
  };
}

export function createPrivateStorage(input: {
  bucket: string;
  assets: AssetRepository;
  client: PrivateObjectClient;
  maxObjectBytes?: number;
}) {
  const maxObjectBytes = input.maxObjectBytes ?? MAX_OBJECT_BYTES;
  if (!Number.isInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > MAX_OBJECT_BYTES) {
    throw new RangeError("El límite de objeto debe ser de 1 a 25 MiB");
  }
  if (!input.bucket.trim()) throw new TypeError("Se requiere el bucket privado configurado");

  return {
    async upload(
      identity: VerifiedIdentityContext,
      request: { assetId?: string; projectId: string; contentType: string; body: Uint8Array; metadata?: Record<string, unknown> },
    ) {
      if (!(request.body instanceof Uint8Array) || request.body.byteLength < 1) {
        throw new TypeError("El objeto debe contener bytes");
      }
      if (request.body.byteLength > maxObjectBytes) {
        throw new RangeError("El objeto supera el límite configurado");
      }
      if (!allowedContentTypes.has(request.contentType.trim().toLowerCase())) {
        throw new TypeError("Tipo de contenido no permitido");
      }
      const body = Buffer.from(request.body);
      const sha256 = sha256Hex(body);
      const contentType = request.contentType.trim().toLowerCase();
      if (request.assetId) {
        const existing = await input.assets.getReady(identity, request.assetId);
        if (existing) {
          if (existing.projectId !== request.projectId || existing.contentType !== contentType || existing.sizeBytes !== body.byteLength ||
              existing.sha256 !== sha256 || canonicalJson(existing.metadata ?? {}) !== canonicalJson(request.metadata ?? {})) {
            throw new IdempotencyConflictError();
          }
          const stored = await input.client.head(existing.objectKey);
          if (stored.sizeBytes !== existing.sizeBytes || stored.sha256 !== existing.sha256) {
            throw new PrivateStorageError("El objeto privado existente no coincide con su registro");
          }
          return { ...publicAsset(existing), created: false };
        }
      }
      const asset = await input.assets.createPending(identity, {
        ...(request.assetId ? { assetId: request.assetId } : {}),
        projectId: request.projectId,
        contentType,
        sizeBytes: body.byteLength,
        sha256,
        ...(request.metadata ? { metadata: request.metadata } : {}),
      });

      try {
        await input.client.put({
          key: asset.objectKey,
          body,
          contentType: asset.contentType,
          sha256,
        });
        const stored = await input.client.head(asset.objectKey);
        if (stored.sizeBytes !== asset.sizeBytes || stored.sha256 !== asset.sha256) {
          throw new PrivateStorageError("La comprobación del objeto almacenado no coincide");
        }
      } catch {
        try {
          await input.client.delete(asset.objectKey);
        } catch {
          // La fila pending/failed permite reconciliar el objeto si la eliminación falla.
        }
        try {
          await input.assets.markFailed(identity, asset.id);
        } catch {
          // Se conserva la fila pendiente para reconciliación si tampoco puede cambiar el estado.
        }
        throw new PrivateStorageError("No se pudo guardar y verificar el objeto privado");
      }
      try {
        const completed = await input.assets.completeUpload(identity, asset.id, sha256, body.byteLength);
        return { ...publicAsset(completed), created: true };
      } catch {
        // No borrar un objeto verificado si el commit pudo haberse confirmado sin respuesta.
        // La fila pending permite reconciliar ambos sistemas sin perder datos.
        throw new PrivateStorageError("El objeto se guardó; su estado quedó pendiente de reconciliación");
      }
    },

    async read(identity: VerifiedIdentityContext, assetId: string) {
      const asset = await input.assets.getReady(identity, assetId);
      if (!asset) throw new OwnedResourceNotFoundError();
      let body: Uint8Array;
      try {
        body = await input.client.get(asset.objectKey);
      } catch {
        throw new PrivateStorageError("No se pudo leer el objeto privado");
      }
      if (body.byteLength !== asset.sizeBytes || sha256Hex(body) !== asset.sha256) {
        throw new PrivateStorageError("El objeto privado no coincide con su checksum");
      }
      return { asset: { ...publicAsset(asset), metadata: asset.metadata ?? {} }, body };
    },

    async delete(identity: VerifiedIdentityContext, assetId: string) {
      const asset = await input.assets.requestDelete(identity, assetId);
      try {
        await input.client.delete(asset.objectKey);
      } catch {
        throw new PrivateStorageError("El asset quedó pendiente de eliminación y requiere reconciliación");
      }
      await input.assets.finishDelete(identity, asset.id);
    },

    close() {
      input.client.close?.();
    },
  };
}

export function createPrivateStorageFromEnvironment(
  assets: AssetRepository,
  source: NodeJS.ProcessEnv = process.env,
) {
  const config = readStorageEnvironment(source);
  return createPrivateStorage({
    bucket: config.S3_BUCKET_PRIVATE,
    assets,
    client: createS3PrivateObjectClient(config),
  });
}

export { createPrivateCheckpointStorage, createPrivateCheckpointStorageFromEnvironment } from "./checkpoints";
export type { PrivateCheckpointIdentity } from "./checkpoints";
export { createPrivateSnapshotStorage, createPrivateSnapshotStorageFromEnvironment, decodeVersionSnapshot, readSnapshotEnvironment, snapshotBytes, snapshotObjectKey, VersionSnapshotSchema } from "./snapshots";
export type { SnapshotLimits, VersionSnapshot, VersionSnapshotFile, VersionSnapshotIdentity, VersionSnapshotMetadata } from "./snapshots";
export { createPublicationArtifactStorage, createPublicationArtifactStorageFromEnvironment, createS3PublicationObjectClient } from "./publications";
export type { PublicationBuildFile, PublicationManifestFile, PublicationObjectClient } from "./publications";
