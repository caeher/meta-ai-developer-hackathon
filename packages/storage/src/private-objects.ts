import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";

export const MAX_PRIVATE_OBJECT_BYTES = 25 * 1024 * 1024;

const storageEnvironmentSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().trim().min(1).max(100),
  S3_BUCKET_PRIVATE: z.string().trim().min(3).max(63),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

export interface PrivateObjectClient {
  put(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    sha256: string;
    ifAbsent?: boolean;
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
          IfNoneMatch: input.ifAbsent ? "*" : undefined,
          Metadata: { sha256: input.sha256 },
        }),
      );
    },
    async head(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: config.S3_BUCKET_PRIVATE, Key: key }),
        );
        return {
          sizeBytes: result.ContentLength,
          sha256: result.Metadata?.sha256,
        };
      } catch (error) {
        if (isMissingObject(error)) return {};
        throw error;
      }
    },
    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.S3_BUCKET_PRIVATE, Key: key }),
      );
      if (!result.Body) throw new PrivateStorageError("El objeto privado no está disponible");
      return collectBounded(result.Body as AsyncIterable<Uint8Array>, MAX_PRIVATE_OBJECT_BYTES);
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET_PRIVATE, Key: key }));
    },
    close() {
      client.destroy();
    },
  };
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === "NotFound" || value.name === "NoSuchKey" ||
    (value.$metadata?.httpStatusCode === 404 && value.name !== "NoSuchBucket");
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
