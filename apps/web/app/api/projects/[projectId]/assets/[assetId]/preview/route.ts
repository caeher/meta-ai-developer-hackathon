import "server-only";
import { createPrivateStorageFromEnvironment } from "@meta-game/storage";
import { createProjectAssetPreviewHandler } from "../../../../../../../server/projects/asset-preview-handler";
import { withProjectApi } from "../../../../../../../server/projects/api";

export function GET(request: Request, context: { params: Promise<{ projectId: string; assetId: string }> }): Promise<Response> {
  return withProjectApi(async ({ identity, repositories }) => {
    const storage = createPrivateStorageFromEnvironment(repositories.assets);
    try {
      return await createProjectAssetPreviewHandler({ identity, repositories, storage }).GET(request, context);
    } finally {
      storage.close();
    }
  });
}
