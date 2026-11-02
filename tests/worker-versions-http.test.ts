import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerVersionServer } from "../apps/worker/src/versions/http";

const projectId = "00000000-0000-4000-8000-000000000111";
const versionId = "00000000-0000-4000-8000-000000000211";
const token = "internal-worker-token-0123456789abcdef";
const servers: ReturnType<typeof createWorkerVersionServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(server: ReturnType<typeof createWorkerVersionServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("worker_test_listen_failed");
  return `http://127.0.0.1:${address.port}`;
}

describe("servicio interno de restauración", () => {
  it("requiere bearer interno y pasa al repositorio solo identidad y IDs validados", async () => {
    const restore = vi.fn(async (identity, requestedProjectId, requestedVersionId) => ({
      user: identity.userId, projectId: requestedProjectId, versionId: requestedVersionId,
    }));
    const server = createWorkerVersionServer({ token, restore });
    servers.push(server);
    const origin = await start(server);
    const endpoint = `${origin}/internal/projects/${projectId}/versions/${versionId}/restore`;
    const denied = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "user_httpOwner001" }) });
    expect(denied.status).toBe(401);
    expect(restore).not.toHaveBeenCalled();

    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_httpOwner001" }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ restored: {
      user: "user_httpOwner001", projectId, versionId,
    } });
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
