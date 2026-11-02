import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { identityFromAuthenticatedSession } from "@meta-game/db";
import {
  createPrivateStorage,
  createPrivateCheckpointStorage,
  type AssetRepository,
  type PrivateObjectClient,
  type StorageAsset,
} from "@meta-game/storage";

const identity = identityFromAuthenticatedSession({ userId: "user_storageUnitA001" });
const projectId = "00000000-0000-4000-8000-000000000111";

function createHarness(options: { corruptHead?: boolean; failComplete?: boolean; failDelete?: boolean } = {}) {
  const records = new Map<string, StorageAsset>();
  const objects = new Map<string, Uint8Array>();
  const calls = { create: 0, deleted: [] as string[] };
  const assets: AssetRepository = {
    async createPending(_identity, input) {
      calls.create += 1;
      const id = randomUUID();
      const asset: StorageAsset = {
        id,
        ownerUserId: "00000000-0000-4000-8000-000000000101",
        projectId: input.projectId,
        objectKey: `private/server-resolved/${projectId}/assets/${id}`,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      records.set(id, asset);
      return asset;
    },
    async getReady(_identity, assetId) {
      const record = records.get(assetId);
      return record?.status === "ready" ? record : undefined;
    },
    async completeUpload(_identity, assetId, checksum, sizeBytes) {
      if (options.failComplete) throw new Error("simulated database timeout");
      const record = records.get(assetId);
      if (!record || record.sha256 !== checksum || record.sizeBytes !== sizeBytes) {
        throw new Error("asset metadata mismatch");
      }
      record.status = "ready";
      return record;
    },
    async markFailed(_identity, assetId) {
      const record = records.get(assetId);
      if (!record) throw new Error("missing asset");
      record.status = "failed";
      return record;
    },
    async requestDelete(_identity, assetId) {
      const record = records.get(assetId);
      if (!record) throw new Error("missing asset");
      record.status = "delete_requested";
      return record;
    },
    async finishDelete(_identity, assetId) {
      records.delete(assetId);
      return { id: assetId };
    },
  };
  const client: PrivateObjectClient = {
    async put(input) {
      objects.set(input.key, Uint8Array.from(input.body));
    },
    async head(key) {
      const body = objects.get(key);
      if (!body) throw new Error("missing object");
      const sha256 = createHash("sha256").update(body).digest("hex");
      return {
        sizeBytes: body.byteLength,
        sha256: options.corruptHead ? "0".repeat(64) : sha256,
      };
    },
    async get(key) {
      const body = objects.get(key);
      if (!body) throw new Error("missing object");
      return Uint8Array.from(body);
    },
    async delete(key) {
      calls.deleted.push(key);
      if (options.failDelete) throw new Error("simulated S3 outage");
      objects.delete(key);
    },
  };
  return {
    records,
    objects,
    calls,
    client,
    storage: createPrivateStorage({ bucket: "private-only", assets, client, maxObjectBytes: 64 }),
  };
}

describe("almacenamiento privado", () => {
  it("guarda checkpoints privados acotados, los valida por checksum y los elimina", async () => {
    const harness = createHarness();
    const checkpoints = createPrivateCheckpointStorage(harness.client);
    const key = {
      ownerUserId: "00000000-0000-4000-8000-000000000101",
      projectId,
      runId: "00000000-0000-4000-8000-000000000201",
    };
    const body = Buffer.from("private checkpoint");
    const metadata = await checkpoints.write(key, body);

    await expect(checkpoints.read(key, metadata)).resolves.toEqual(Uint8Array.from(body));
    await checkpoints.delete(key);
    expect(harness.objects.size).toBe(0);
    await expect(checkpoints.read(key, metadata)).rejects.toThrow("checkpoint privado");
  });

  it("deriva la clave en servidor, calcula checksum y oculta la clave al cliente", async () => {
    const harness = createHarness();
    const body = Buffer.from("fixture object data");
    const result = await harness.storage.upload(identity, {
      projectId,
      contentType: "application/octet-stream",
      body,
    });
    const stored = harness.records.get(result.id);

    expect(stored?.objectKey).toMatch(/^private\/server-resolved\//);
    expect(result).not.toHaveProperty("objectKey");
    expect(result.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(result.status).toBe("ready");
    expect(Buffer.from((await harness.storage.read(identity, result.id)).body)).toEqual(body);
  });

  it("rechaza MIME no permitido y bytes sobre el límite antes de reservar metadata", async () => {
    const harness = createHarness();
    await expect(
      harness.storage.upload(identity, {
        projectId,
        contentType: "text/html",
        body: Buffer.from("<script></script>"),
      }),
    ).rejects.toThrow("Tipo de contenido no permitido");
    await expect(
      harness.storage.upload(identity, {
        projectId,
        contentType: "application/octet-stream",
        body: Buffer.alloc(65),
      }),
    ).rejects.toThrow("límite configurado");
    expect(harness.calls.create).toBe(0);
  });

  it("limpia objetos que no pasan la verificación y deja registro de fallo", async () => {
    const harness = createHarness({ corruptHead: true });
    await expect(
      harness.storage.upload(identity, {
        projectId,
        contentType: "application/octet-stream",
        body: Buffer.from("bad checksum"),
      }),
    ).rejects.toThrow("No se pudo guardar y verificar");
    const [asset] = [...harness.records.values()];
    expect(asset?.status).toBe("failed");
    expect(harness.objects.size).toBe(0);
    expect(harness.calls.deleted).toHaveLength(1);
  });

  it("retiene el objeto verificado si el commit de metadata queda ambiguo", async () => {
    const harness = createHarness({ failComplete: true });
    await expect(
      harness.storage.upload(identity, {
        projectId,
        contentType: "application/octet-stream",
        body: Buffer.from("commit may have succeeded"),
      }),
    ).rejects.toThrow("pendiente de reconciliación");
    expect(harness.objects.size).toBe(1);
    expect([...harness.records.values()][0]?.status).toBe("pending");
    expect(harness.calls.deleted).toHaveLength(0);
  });

  it("marca delete_requested antes de borrar el objeto y metadata", async () => {
    const harness = createHarness();
    const result = await harness.storage.upload(identity, {
      projectId,
      contentType: "application/octet-stream",
      body: Buffer.from("delete me"),
    });
    const key = harness.records.get(result.id)?.objectKey;
    await harness.storage.delete(identity, result.id);
    expect(harness.records.has(result.id)).toBe(false);
    expect(key && harness.objects.has(key)).toBe(false);
  });

  it("deja delete_requested cuando S3 no confirma el borrado", async () => {
    const harness = createHarness({ failDelete: true });
    const result = await harness.storage.upload(identity, {
      projectId,
      contentType: "application/octet-stream",
      body: Buffer.from("retry delete later"),
    });
    await expect(harness.storage.delete(identity, result.id)).rejects.toThrow(
      "pendiente de eliminación",
    );
    expect(harness.records.get(result.id)?.status).toBe("delete_requested");
    expect(harness.objects.size).toBe(1);
  });
});
