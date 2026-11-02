import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPrivateSnapshotStorageFromEnvironment,
  type VersionSnapshot,
} from "@meta-game/storage";

const integrationEnabled = process.env.PERSISTENCE_TEST_ENABLED === "1";
const snapshots = integrationEnabled ? createPrivateSnapshotStorageFromEnvironment(process.env) : undefined;
const ownerUserId = "00000000-0000-4000-8000-000000000101";
const projectId = "00000000-0000-4000-8000-000000000111";
const versionId = randomUUID();
const gameSpec = {
  schemaVersion: 1 as const,
  genre: "platformer" as const,
  intent: "create" as const,
  objective: "Snapshot S3 aislado",
  changes: [],
  controls: { movement: "arrows" as const, action: "space" as const, touch: true as const },
};
const content = `${JSON.stringify(gameSpec)}\n`;
const snapshot: VersionSnapshot = {
  schemaVersion: 1,
  projectId,
  versionId,
  runId: null,
  parentVersionId: null,
  gameSpec,
  verification: { status: "passed", checks: [{ check: "build", status: "passed", summary: "Build correcto" }] },
  files: [{
    path: "src/game/project-spec.json",
    encoding: "utf8",
    content,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  }],
  totalBytes: Buffer.byteLength(content),
};

describe.skipIf(!integrationEnabled)("snapshots privados en S3", () => {
  afterAll(() => snapshots?.close?.());

  it("guarda con clave privada, verifica checksums y no reemplaza una versión", async () => {
    const storage = snapshots!;
    const identity = { ownerUserId, projectId, versionId };
    try {
      const metadata = await storage.write(identity, snapshot);
      await expect(storage.read(identity, metadata)).resolves.toEqual(snapshot);
      const modified = {
        ...snapshot,
        files: [{ ...snapshot.files[0]!, content: `${content}modificado`, bytes: Buffer.byteLength(`${content}modificado`), sha256: createHash("sha256").update(`${content}modificado`).digest("hex") }],
        totalBytes: Buffer.byteLength(`${content}modificado`),
      };
      await expect(storage.write(identity, modified)).rejects.toThrow();
      await expect(storage.read(identity, metadata)).resolves.toEqual(snapshot);
    } finally {
      await storage.delete(identity).catch(() => undefined);
    }
  });
});
