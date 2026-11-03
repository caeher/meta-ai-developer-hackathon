import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { identityFromAuthenticatedSession, type VerifiedIdentityContext } from "@meta-game/db";
import { createProjectAssetPreviewHandler } from "../apps/web/server/projects/asset-preview-handler";

const owner = identityFromAuthenticatedSession({ userId: "user_assetPreviewOwner" });
const otherOwner = identityFromAuthenticatedSession({ userId: "user_assetPreviewOther" });
const projectId = randomUUID();
const assetId = randomUUID();
const bytes = new Uint8Array([137, 80, 78, 71]);

function createHandler(identity: VerifiedIdentityContext, options: { assetProjectId?: string; contentType?: string; projectExists?: boolean } = {}) {
  const asset = {
    id: assetId,
    projectId: options.assetProjectId ?? projectId,
    contentType: options.contentType ?? "image/png",
    sizeBytes: bytes.byteLength,
    sha256: "a".repeat(64),
  };
  const projects = { get: vi.fn(async (who: VerifiedIdentityContext) => options.projectExists === false || who.userId !== owner.userId ? undefined : ({ id: projectId })) };
  const assets = { getReady: vi.fn(async (who: VerifiedIdentityContext) => who.userId === owner.userId ? asset : undefined) };
  const storage = {
    read: vi.fn(async (who: VerifiedIdentityContext, id: string) => ({
      asset: { ...asset, id }, body: bytes,
    })),
  };
  return {
    handler: createProjectAssetPreviewHandler({ identity, repositories: { projects, assets } as never, storage }),
    projects, assets, storage,
  };
}

const context = { params: Promise.resolve({ projectId, assetId }) };

describe("preview privada de assets", () => {
  it("sirve bytes de imagen solo con ownership de proyecto y asset, sin cache ni URL bearer", async () => {
    const { handler } = createHandler(owner);
    const response = await handler.GET(new Request("http://localhost/api/preview"), context);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="asset.png"');
  });

  it("oculta el proyecto o asset ajeno con el mismo 404", async () => {
    const ownerHandler = createHandler(owner, { projectExists: false }).handler;
    const foreignProjectHandler = createHandler(owner, { assetProjectId: randomUUID() }).handler;
    const foreignOwnerHandler = createHandler(otherOwner).handler;
    const responses = await Promise.all([
      ownerHandler.GET(new Request("http://localhost/api/preview"), context),
      foreignProjectHandler.GET(new Request("http://localhost/api/preview"), context),
      foreignOwnerHandler.GET(new Request("http://localhost/api/preview"), context),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { error: "not_found" }, { error: "not_found" }, { error: "not_found" },
    ]);
  });

  it("no publica descriptores JSON como imagen ni lee su objeto", async () => {
    const { handler, storage } = createHandler(owner, { contentType: "application/json" });
    const response = await handler.GET(new Request("http://localhost/api/preview"), context);
    expect(response.status).toBe(404);
    expect(storage.read).not.toHaveBeenCalled();
  });
});
