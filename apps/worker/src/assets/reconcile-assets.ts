const ASSET_RECONCILIATION_AGE_MS = 30 * 60_000;

export type AssetReconciliationCandidate = {
  id: string;
  ownerUserId: string;
  projectId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  status: "pending" | "ready" | "delete_requested" | "failed";
  updatedAt: Date;
};

export interface AssetReconciliationRepository {
  listAssetReconciliationCandidates(cutoff: Date, limit: number): Promise<AssetReconciliationCandidate[]>;
  reconcileAssetCandidate(input: {
    id: string;
    ownerUserId: string;
    projectId: string;
    sha256: string;
    sizeBytes: number;
    updatedAt: Date;
    cutoff: Date;
    action: "ready" | "failed" | "deleted" | "cleaned";
  }): Promise<boolean>;
}

export interface AssetReconciliationObjects {
  head(key: string): Promise<{ sizeBytes?: number; sha256?: string }>;
  delete(key: string): Promise<void>;
}

/**
 * ADR-0002: PostgreSQL y S3 no comparten transaccion. Este reconciliador
 * cierra las filas que quedaron a mitad de camino sin perder datos:
 * - pending con objeto verificado (sha256+tamano) -> ready
 * - pending sin objeto o corrupto -> borra el resto y marca failed
 * - delete_requested -> reintenta el borrado y elimina la fila
 * - failed con objeto huerfano -> borra el objeto, conserva la fila
 * Un error transitorio de S3 difiere la fila sin tocarla.
 */
export function createAssetReconciler(input: {
  assets: AssetReconciliationRepository;
  objects: AssetReconciliationObjects;
}) {
  return {
    async reconcilePendingAssets(options: { now?: number; limit?: number } = {}) {
      const now = options.now ?? Date.now();
      const limit = options.limit ?? 100;
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(limit) || limit < 1 || limit > 250) {
        throw new RangeError("Limites de reconciliacion invalidos");
      }
      const cutoff = new Date(now - ASSET_RECONCILIATION_AGE_MS);
      const candidates = await input.assets.listAssetReconciliationCandidates(cutoff, limit);
      const result = { scanned: candidates.length, recovered: 0, failed: 0, deleted: 0, cleaned: 0, deferred: 0 };
      for (const candidate of candidates) {
        try {
          if (candidate.status === "delete_requested") {
            await input.objects.delete(candidate.objectKey);
            const changed = await input.assets.reconcileAssetCandidate({
              id: candidate.id, ownerUserId: candidate.ownerUserId, projectId: candidate.projectId,
              sha256: candidate.sha256, sizeBytes: candidate.sizeBytes,
              updatedAt: candidate.updatedAt, cutoff, action: "deleted",
            });
            if (changed) result.deleted += 1;
            continue;
          }
          const stored = await input.objects.head(candidate.objectKey);
          const matches = stored.sizeBytes === candidate.sizeBytes && stored.sha256 === candidate.sha256;
          if (candidate.status === "failed") {
            const hadObject = stored.sizeBytes !== undefined;
            if (hadObject) await input.objects.delete(candidate.objectKey);
            // Toque CAS: la fila sale de la ventana de 30 min y no puede
            // bloquear a los pending nuevos en cada pasada.
            await input.assets.reconcileAssetCandidate({
              id: candidate.id, ownerUserId: candidate.ownerUserId, projectId: candidate.projectId,
              sha256: candidate.sha256, sizeBytes: candidate.sizeBytes,
              updatedAt: candidate.updatedAt, cutoff, action: "cleaned",
            });
            if (hadObject) result.cleaned += 1;
            continue;
          }
          // pending
          if (!matches && stored.sizeBytes !== undefined) {
            await input.objects.delete(candidate.objectKey);
          }
          const changed = await input.assets.reconcileAssetCandidate({
            id: candidate.id, ownerUserId: candidate.ownerUserId, projectId: candidate.projectId,
            sha256: candidate.sha256, sizeBytes: candidate.sizeBytes,
            updatedAt: candidate.updatedAt, cutoff, action: matches ? "ready" : "failed",
          });
          if (changed) {
            if (matches) result.recovered += 1;
            else result.failed += 1;
          }
        } catch {
          result.deferred += 1;
        }
      }
      return result;
    },
  };
}
