import { OwnedResourceNotFoundError, type VerifiedIdentityContext } from "@meta-game/db";
import { apiErrorResponse } from "../auth/http";

const maximumPreviewBytes = 8 * 1024 * 1024;
const inlineImageTypes = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

type AssetPreviewRepositories = Readonly<{
  projects: { get(identity: VerifiedIdentityContext, projectId: string): Promise<unknown> };
  assets: {
    getReady(identity: VerifiedIdentityContext, assetId: string): Promise<{
      id: string;
      projectId: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    } | undefined>;
  };
}>;

type PrivateAssetPreviewStorage = Readonly<{
  read(identity: VerifiedIdentityContext, assetId: string): Promise<{
    asset: { id: string; projectId: string; contentType: string; sizeBytes: number; sha256: string };
    body: Uint8Array;
  }>;
}>;

export function createProjectAssetPreviewHandler(input: {
  identity: VerifiedIdentityContext;
  repositories: AssetPreviewRepositories;
  storage: PrivateAssetPreviewStorage;
}) {
  return {
    async GET(_request: Request, context: { params: Promise<{ projectId: string; assetId: string }> }): Promise<Response> {
      try {
        const { projectId, assetId } = await context.params;
        const project = await input.repositories.projects.get(input.identity, projectId);
        if (!project) throw new OwnedResourceNotFoundError();
        const asset = await input.repositories.assets.getReady(input.identity, assetId);
        const extension = asset ? inlineImageTypes.get(asset.contentType) : undefined;
        if (!asset || asset.projectId !== projectId || !extension || asset.sizeBytes < 1 || asset.sizeBytes > maximumPreviewBytes) {
          throw new OwnedResourceNotFoundError();
        }
        const stored = await input.storage.read(input.identity, assetId);
        if (stored.asset.id !== assetId || stored.asset.projectId !== projectId || stored.asset.contentType !== asset.contentType ||
            stored.asset.sizeBytes !== asset.sizeBytes || stored.asset.sha256 !== asset.sha256 || stored.body.byteLength !== asset.sizeBytes) {
          throw new OwnedResourceNotFoundError();
        }
        const body = new ArrayBuffer(stored.body.byteLength);
        new Uint8Array(body).set(stored.body);
        return new Response(body, {
          headers: {
            "cache-control": "private, no-store, max-age=0",
            "content-type": asset.contentType,
            "content-length": String(asset.sizeBytes),
            "content-disposition": `inline; filename="asset.${extension}"`,
            "cross-origin-resource-policy": "same-origin",
            "referrer-policy": "no-referrer",
            "vary": "Cookie",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return apiErrorResponse(error);
      }
    },
  };
}
