import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  OwnedResourceNotFoundError,
  type VerifiedIdentityContext,
} from "@meta-game/db";

const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const allowedContentTypes = new Set([
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

const storageEnvironmentSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().trim().min(1).max(100),
  S3_BUCKET_PRIVATE: z.string().trim().min(3).max(63),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

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
    input: { projectId: string; contentType: string; sizeBytes: number; sha256: string; metadata?: Record<string, unknown> },
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

export interface PrivateObjectClient {
  put(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    sha256: string;
  }): Promise<void>;
  head(key: string): Promise<{ sizeBytes?: number; sha256?: string }>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  close?(): void;
}

export class PrivateStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateStorageError";
  }
}

export function readStorageEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const parsed = storageEnvironmentSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error("Configuración S3 inválida; revisa S3_ENDPOINT, S3_REGION, S3_BUCKET_PRIVATE y las credenciales.");
  }
  return parsed.data;
}

export function createS3PrivateObjectClient(
  config: ReturnType<typeof readStorageEnvironment>,
): PrivateObjectClient {
  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    maxAttempts: 2,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
  });

  return {
    async put(input) {
      const checksum = Buffer.from(input.sha256, "hex").toString("base64");
      await client.send(
        new PutObjectCommand({
          Bucket: config.S3_BUCKET_PRIVATE,
          Key: input.key,
          Body: input.body,
          ContentLength: input.body.byteLength,
          ContentType: input.contentType,
          ContentDisposition: "attachment",
          CacheControl: "private, no-store",
          ChecksumSHA256: checksum,
          Metadata: { sha256: input.sha256 },
        }),
      );
    },
    async head(key) {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: config.S3_BUCKET_PRIVATE, Key: key }),
      );
      return {
        sizeBytes: result.ContentLength,
        sha256: result.Metadata?.sha256,
      };
    },
    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.S3_BUCKET_PRIVATE, Key: key }),
      );
      if (!result.Body) throw new PrivateStorageError("El objeto privado no está disponible");
      return collectBounded(result.Body as AsyncIterable<Uint8Array>, MAX_OBJECT_BYTES);
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET_PRIVATE, Key: key }));
    },
    close() {
      client.destroy();
    },
  };
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function collectBounded(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = source as AsyncIterable<Uint8Array> & { destroy?: () => void };
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      stream.destroy?.();
      throw new PrivateStorageError("El objeto supera el límite configurado");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, totalBytes);
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
      request: { projectId: string; contentType: string; body: Uint8Array; metadata?: Record<string, unknown> },
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
      const asset = await input.assets.createPending(identity, {
        projectId: request.projectId,
        contentType: request.contentType.trim().toLowerCase(),
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
        return publicAsset(completed);
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
