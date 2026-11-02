import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PUBLICATION_MAX_FILE_BYTES,
  PUBLICATION_MAX_TOTAL_BYTES,
  canonicalPublicationManifest,
  PublicationFileSchema,
  PublicationManifestSchema,
  publicationArtifactKey,
  type PublicationManifest,
} from "@meta-game/contracts";

export class PublicationStorageError extends Error {
  constructor(message: string) { super(message); this.name = "PublicationStorageError"; }
}

const MAX_OBJECT_BYTES = PUBLICATION_MAX_FILE_BYTES;
const workerEnvironmentSchema = z.object({
  S3_ENDPOINT: z.string().url(), S3_REGION: z.string().trim().min(1).max(100),
  S3_BUCKET_PUBLIC: z.string().trim().min(3).max(63),
  PUBLISH_S3_ACCESS_KEY_ID: z.string().min(1), PUBLISH_S3_SECRET_ACCESS_KEY: z.string().min(1),
});
const readerEnvironmentSchema = z.object({
  S3_ENDPOINT: z.string().url(), S3_REGION: z.string().trim().min(1).max(100),
  S3_BUCKET_PUBLIC: z.string().trim().min(3).max(63),
  PUBLISH_READ_ACCESS_KEY_ID: z.string().min(1), PUBLISH_READ_SECRET_ACCESS_KEY: z.string().min(1),
});

export type PublicationBuildFile = Readonly<{ path: string; contentType: string; body: Uint8Array }>;
export type PublicationManifestFile = PublicationManifest["files"][number];

export interface PublicationObjectClient {
  put(key: string, body: Uint8Array, contentType: string, sha256: string): Promise<void>;
  head(key: string): Promise<{ sizeBytes?: number; sha256?: string }>;
  get(key: string): Promise<Uint8Array>;
  deletePrefix(prefix: string): Promise<void>;
  close?(): void;
}

export function createS3PublicationObjectClient(config: {
  endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string;
}): PublicationObjectClient {
  const client = new S3Client({
    endpoint: config.endpoint, region: config.region, forcePathStyle: true, maxAttempts: 2,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    async put(key, body, contentType, sha256) {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: body, ContentLength: body.byteLength,
        ContentType: contentType, ContentDisposition: "inline", CacheControl: "public, max-age=60, s-maxage=60",
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"), IfNoneMatch: "*", Metadata: { sha256 },
      }));
    },
    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return { sizeBytes: result.ContentLength, sha256: result.Metadata?.sha256 };
      } catch (error) {
        if (isMissingObject(error)) return {};
        throw error;
      }
    },
    async get(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      if (!result.Body) throw new PublicationStorageError("El artefacto publicado no está disponible");
      return collectBounded(result.Body as AsyncIterable<Uint8Array>, MAX_OBJECT_BYTES);
    },
    async deletePrefix(prefix) {
      if (!/^published\/[a-f0-9]{20}$/.test(prefix)) throw new TypeError("Prefijo de publicación inválido");
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `${prefix}/`, ContinuationToken: token }));
        const objects = (page.Contents ?? []).filter((object) => object.Key?.startsWith(`${prefix}/`) && object.Key.length <= 1_100)
          .map(({ Key }) => ({ Key }));
        if (objects.length) await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: objects, Quiet: true } }));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
    close() { client.destroy(); },
  };
}

export function createPublicationArtifactStorage(client: PublicationObjectClient) {
  return {
    async write(slug: string, files: readonly PublicationBuildFile[]): Promise<{ manifest: PublicationManifest; artifactSha256: string }> {
      if (!Array.isArray(files) || files.length < 1 || files.length > 1_024) throw new RangeError("La build supera la cantidad de archivos permitida");
      const paths = new Set<string>();
      let totalBytes = 0;
      const candidates: Array<{ manifestFile: PublicationManifestFile; body: Uint8Array }> = [];
      for (const file of files) {
        if (!(file.body instanceof Uint8Array) || file.body.byteLength < 1 || file.body.byteLength > MAX_OBJECT_BYTES) {
          throw new RangeError("El archivo compilado supera el límite permitido");
        }
        const sha256 = digest(file.body);
        const manifestFile = PublicationFileSchema.parse({
          path: file.path, contentType: file.contentType, bytes: file.body.byteLength, sha256,
          key: publicationArtifactKey(slug, file.path),
        });
        if (paths.has(manifestFile.path)) throw new TypeError("La build contiene rutas duplicadas");
        paths.add(manifestFile.path);
        totalBytes += file.body.byteLength;
        if (totalBytes > PUBLICATION_MAX_TOTAL_BYTES) throw new RangeError("La build supera el tamaño total permitido");
        candidates.push({ manifestFile, body: Uint8Array.from(file.body) });
      }
      const index = candidates.find(({ manifestFile }) => manifestFile.path === "index.html");
      if (!index) throw new TypeError("La build no contiene index.html");
      const filesManifest = candidates.map(({ manifestFile }) => manifestFile).sort((a, b) => a.path.localeCompare(b.path));
      const manifest = PublicationManifestSchema.parse({
        schemaVersion: 1, files: filesManifest, totalBytes, indexSha256: index.manifestFile.sha256,
      });
      const artifactSha256 = digest(Buffer.from(canonicalPublicationManifest(manifest), "utf8"));
      for (const { manifestFile, body } of candidates) {
        try {
          await client.put(manifestFile.key, body, manifestFile.contentType, manifestFile.sha256);
        } catch {
          const existing = await client.head(manifestFile.key).catch((): { sizeBytes?: number; sha256?: string } => ({}));
          if (existing.sizeBytes !== manifestFile.bytes || existing.sha256 !== manifestFile.sha256) {
            throw new PublicationStorageError("El artefacto inmutable no coincide con la build verificada");
          }
        }
        const stored = await client.head(manifestFile.key);
        if (stored.sizeBytes !== manifestFile.bytes || stored.sha256 !== manifestFile.sha256) {
          throw new PublicationStorageError("La verificación del artefacto publicado falló");
        }
      }
      return { manifest, artifactSha256 };
    },

    async read(slug: string, manifestFile: PublicationManifestFile): Promise<Uint8Array> {
      const parsed = PublicationFileSchema.parse(manifestFile);
      if (parsed.key !== publicationArtifactKey(slug, parsed.path)) throw new TypeError("La ruta no pertenece a esta publicación");
      const body = await client.get(parsed.key);
      if (body.byteLength !== parsed.bytes || digest(body) !== parsed.sha256) throw new PublicationStorageError("El objeto publicado no coincide con el manifiesto");
      return body;
    },

    async delete(slug: string) {
      await client.deletePrefix(`published/${z.string().regex(/^[a-f0-9]{20}$/).parse(slug)}`);
    },

    close() { client.close?.(); },
  };
}

export function createPublicationArtifactStorageFromEnvironment(source: NodeJS.ProcessEnv = process.env, role: "worker" | "reader" = "worker") {
  const config = (role === "worker" ? workerEnvironmentSchema : readerEnvironmentSchema).parse(source);
  const client = createS3PublicationObjectClient({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET_PUBLIC,
    accessKeyId: role === "worker" ? (config as z.infer<typeof workerEnvironmentSchema>).PUBLISH_S3_ACCESS_KEY_ID : (config as z.infer<typeof readerEnvironmentSchema>).PUBLISH_READ_ACCESS_KEY_ID,
    secretAccessKey: role === "worker" ? (config as z.infer<typeof workerEnvironmentSchema>).PUBLISH_S3_SECRET_ACCESS_KEY : (config as z.infer<typeof readerEnvironmentSchema>).PUBLISH_READ_SECRET_ACCESS_KEY,
  });
  return createPublicationArtifactStorage(client);
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === "NotFound" || value.name === "NoSuchKey" || (value.$metadata?.httpStatusCode === 404 && value.name !== "NoSuchBucket");
}

async function collectBounded(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const stream = source as AsyncIterable<Uint8Array> & { destroy?: () => void };
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) { stream.destroy?.(); throw new PublicationStorageError("El artefacto supera el límite permitido"); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, totalBytes);
}
