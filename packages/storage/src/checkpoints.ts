import { createHash } from "node:crypto";
import { z } from "zod";
import { PrivateStorageError, createS3PrivateObjectClient, readStorageEnvironment, type PrivateObjectClient } from "./index.js";

const objectId = z.string().uuid();

export type PrivateCheckpointIdentity = Readonly<{ ownerUserId: string; projectId: string; runId: string }>;

export function createPrivateCheckpointStorage(client: PrivateObjectClient, maxObjectBytes = 25 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > 25 * 1024 * 1024) {
    throw new RangeError("El límite del checkpoint privado debe ser de 1 a 25 MiB");
  }
  const keyFor = (identity: PrivateCheckpointIdentity) => {
    const parsed = z.object({ ownerUserId: objectId, projectId: objectId, runId: objectId }).strict().parse(identity);
    return `private/${parsed.ownerUserId}/projects/${parsed.projectId}/checkpoints/${parsed.runId}`;
  };

  return {
    async write(identity: PrivateCheckpointIdentity, body: Uint8Array) {
      if (!(body instanceof Uint8Array) || body.byteLength < 1 || body.byteLength > maxObjectBytes) {
        throw new RangeError("El checkpoint privado supera el límite permitido");
      }
      const sha256 = createHash("sha256").update(body).digest("hex");
      const key = keyFor(identity);
      try {
        await client.put({ key, body, contentType: "application/gzip", sha256 });
        const stored = await client.head(key);
        if (stored.sizeBytes !== body.byteLength || stored.sha256 !== sha256) throw new Error("checksum_mismatch");
      } catch {
        throw new PrivateStorageError("No se pudo guardar y verificar el checkpoint privado");
      }
      return { sha256, sizeBytes: body.byteLength };
    },

    async read(identity: PrivateCheckpointIdentity, expected: { sha256: string; sizeBytes: number }) {
      const key = keyFor(identity);
      try {
        const stored = await client.head(key);
        if (stored.sizeBytes !== expected.sizeBytes || stored.sha256 !== expected.sha256) throw new Error("checkpoint_metadata_mismatch");
        const body = await client.get(key);
        const sha256 = createHash("sha256").update(body).digest("hex");
        if (body.byteLength !== expected.sizeBytes || sha256 !== expected.sha256) throw new Error("checkpoint_checksum_mismatch");
        return body;
      } catch {
        throw new PrivateStorageError("No se pudo leer y verificar el checkpoint privado");
      }
    },

    async delete(identity: PrivateCheckpointIdentity) {
      try { await client.delete(keyFor(identity)); }
      catch { throw new PrivateStorageError("No se pudo eliminar el checkpoint privado"); }
    },
  };
}

export function createPrivateCheckpointStorageFromEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const config = readStorageEnvironment(source);
  const client = createS3PrivateObjectClient(config);
  const storage = createPrivateCheckpointStorage(client);
  return { ...storage, close: () => client.close?.() };
}
