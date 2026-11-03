import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAssetReconciler } from "../apps/worker/src/assets/reconcile-assets";

const ownerUserId = "00000000-0000-4000-8000-000000000101";
const projectId = "00000000-0000-4000-8000-000000000111";
const old = new Date(Date.now() - 31 * 60_000);

type Row = {
  id: string;
  ownerUserId: string;
  projectId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  status: "pending" | "ready" | "delete_requested" | "failed";
  updatedAt: Date;
};

function sha(body: Uint8Array) {
  return createHash("sha256").update(body).digest("hex");
}

function makeHarness() {
  const rows = new Map<string, Row>();
  const objects = new Map<string, Uint8Array>();
  let failHead = false;
  const assets = {
    async listAssetReconciliationCandidates(cutoff: Date, limit: number) {
      return [...rows.values()]
        .filter((row) => row.status !== "ready" && row.updatedAt < cutoff)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .slice(0, limit);
    },
    async reconcileAssetCandidate(input: {
      id: string; ownerUserId: string; projectId: string; sha256: string; sizeBytes: number;
      updatedAt: Date; cutoff: Date; action: "ready" | "failed" | "deleted" | "cleaned";
    }) {
      const row = rows.get(input.id);
      if (!row || row.ownerUserId !== input.ownerUserId || row.projectId !== input.projectId
        || row.sha256 !== input.sha256 || row.sizeBytes !== input.sizeBytes
        || row.updatedAt.getTime() !== input.updatedAt.getTime() || row.updatedAt >= input.cutoff) return false;
      if (input.action === "ready" && row.status !== "pending") return false;
      if (input.action === "failed" && row.status !== "pending") return false;
      if (input.action === "deleted" && row.status !== "delete_requested") return false;
      if (input.action === "cleaned" && row.status !== "failed") return false;
      if (input.action === "deleted") rows.delete(row.id);
      else if (input.action !== "cleaned") row.status = input.action;
      if (input.action === "cleaned") row.updatedAt = new Date();
      return true;
    },
  };
  const client = {
    async head(key: string) {
      if (failHead) { failHead = false; throw new Error("fixture_storage_unavailable"); }
      const body = objects.get(key);
      return body ? { sizeBytes: body.byteLength, sha256: sha(body) } : {};
    },
    async delete(key: string) { objects.delete(key); },
  };
  return {
    rows, objects, assets, client,
    failNextHead() { failHead = true; },
    add(row: Partial<Row> & { id: string; status: Row["status"] }, body?: Uint8Array) {
      const bytes = body ?? Uint8Array.from([1, 2, 3]);
      const full: Row = {
        ownerUserId, projectId,
        objectKey: `private/${ownerUserId}/projects/${projectId}/assets/${row.id}`,
        sha256: sha(bytes), sizeBytes: bytes.byteLength, updatedAt: old, ...row,
      } as Row;
      rows.set(full.id, full);
      if (body) objects.set(full.objectKey, body);
      return full;
    },
  };
}

describe("reconciliador de assets privados (ADR-0002)", () => {
  it("promueve a ready un pending cuyo objeto verificado si se guardo", async () => {
    const h = makeHarness();
    const body = Uint8Array.from([9, 8, 7]);
    const row = h.add({ id: "00000000-0000-4000-8000-000000000201", status: "pending" }, body);
    const reconciler = createAssetReconciler({ assets: h.assets, objects: h.client });
    await expect(reconciler.reconcilePendingAssets()).resolves.toMatchObject({ scanned: 1, recovered: 1, failed: 0, deleted: 0, deferred: 0 });
    expect(h.rows.get(row.id)?.status).toBe("ready");
  });

  it("marca failed un pending sin objeto y no lo promueve", async () => {
    const h = makeHarness();
    const row = h.add({ id: "00000000-0000-4000-8000-000000000202", status: "pending" });
    const reconciler = createAssetReconciler({ assets: h.assets, objects: h.client });
    await expect(reconciler.reconcilePendingAssets()).resolves.toMatchObject({ scanned: 1, recovered: 0, failed: 1 });
    expect(h.rows.get(row.id)?.status).toBe("failed");
  });

  it("borra el objeto huerfano de un pending corrupto antes de marcarlo failed", async () => {
    const h = makeHarness();
    const row = h.add({ id: "00000000-0000-4000-8000-000000000203", status: "pending" }, Uint8Array.from([1]));
    h.objects.set(row.objectKey, Uint8Array.from([5, 5, 5, 5]));
    const reconciler = createAssetReconciler({ assets: h.assets, objects: h.client });
    await expect(reconciler.reconcilePendingAssets()).resolves.toMatchObject({ failed: 1 });
    expect(h.objects.has(row.objectKey)).toBe(false);
    expect(h.rows.get(row.id)?.status).toBe("failed");
  });

  it("completa un delete_requested reintentando el borrado en S3", async () => {
    const h = makeHarness();
    const row = h.add({ id: "00000000-0000-4000-8000-000000000204", status: "delete_requested" }, Uint8Array.from([2]));
    const reconciler = createAssetReconciler({ assets: h.assets, objects: h.client });
    await expect(reconciler.reconcilePendingAssets()).resolves.toMatchObject({ scanned: 1, deleted: 1 });
    expect(h.objects.has(row.objectKey)).toBe(false);
    expect(h.rows.has(row.id)).toBe(false);
  });

  it("elimina el objeto huerfano de una fila failed conservando la fila", async () => {
    const h = makeHarness();
    const row = h.add({ id: "00000000-0000-4000-8000-000000000205", status: "failed" }, Uint8Array.from([3]));
    const reconciler = createAssetReconciler({ assets: h.assets, objects: h.client });
    await expect(reconciler.reconcilePendingAssets()).resolves.toMatchObject({ scanned: 1, cleaned: 1 });
    expect(h.objects.has(row.objectKey)).toBe(false);
    expect(h.rows.get(row.id)?.status).toBe("failed");
  });

  it("difiere sin tocar la fila cuando S3 falla de forma transitoria", async () => {
    const h = makeHarness();
    const row = h.add({ id: "00000000-0000-4000-8000-000000000206", status: "pending" }, Uint8Array.from([4]));
    h.failNextHead();
    const reconciler = createAssetReconciler({ assets: h.assets, objects: h.client });
    await expect(reconciler.reconcilePendingAssets()).resolves.toMatchObject({ scanned: 1, deferred: 1, recovered: 0 });
    expect(h.rows.get(row.id)?.status).toBe("pending");
  });

  it("ignora filas recientes que aun pueden estar en vuelo", async () => {
    const h = makeHarness();
    const row = h.add({ id: "00000000-0000-4000-8000-000000000207", status: "pending" }, Uint8Array.from([6]));
    row.updatedAt = new Date();
    const reconciler = createAssetReconciler({ assets: h.assets, objects: h.client });
    await expect(reconciler.reconcilePendingAssets()).resolves.toMatchObject({ scanned: 0 });
    expect(h.rows.get(row.id)?.status).toBe("pending");
  });
});
