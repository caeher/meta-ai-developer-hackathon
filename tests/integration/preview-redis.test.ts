import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { createRedisPreviewStore } from "@meta-game/preview";

const redisUrl = process.env.PREVIEW_TEST_REDIS_URL;
const redisIt = redisUrl ? it : it.skip;

describe("preview Redis: consumo atómico y revocación", () => {
  let store: ReturnType<typeof createRedisPreviewStore> | undefined;
  let peerStore: ReturnType<typeof createRedisPreviewStore> | undefined;
  let cleanup: Redis | undefined;
  let ownedKeys: string[] = [];

  afterEach(async () => {
    await store?.close();
    await peerStore?.close();
    store = undefined;
    peerStore = undefined;
    if (cleanup) {
      if (ownedKeys.length) await cleanup.del(...ownedKeys);
      await cleanup.quit();
      cleanup = undefined;
    }
    ownedKeys = [];
  });

  redisIt("consume una sola vez bajo concurrencia y deniega sesiones tras cambiar epoch", async () => {
    const projectId = randomUUID();
    const grantId = randomUUID();
    const sessionIdHash = "a".repeat(64);
    ownedKeys = [
      `preview:epoch:${projectId}`,
      `preview:grant:${grantId}`,
      `preview:session:${sessionIdHash}`,
      `preview:project-sessions:${projectId}`,
    ];
    store = createRedisPreviewStore(redisUrl!);
    peerStore = createRedisPreviewStore(redisUrl!);
    cleanup = new Redis(redisUrl!, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    await cleanup.connect();

    expect(await store.getProjectEpoch(projectId)).toBe(0);
    const input = {
      projectId,
      grantId,
      epoch: 0,
      grantTtlSeconds: 60,
      sessionIdHash,
      session: { userId: "user_previewRedis", projectId, epoch: 0, expiresAt: Math.floor(Date.now() / 1000) + 30 },
      sessionTtlSeconds: 30,
    };
    const consumed = await Promise.all([
      store.createSessionFromGrant(input),
      peerStore.createSessionFromGrant(input),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect(await store.readSession(sessionIdHash, projectId)).toMatchObject({ projectId, userId: "user_previewRedis", epoch: 0 });
    expect(await store.hasActiveProjectSessions(projectId)).toBe(true);

    expect(await store.revokeProject(projectId)).toBe(1);
    expect(await store.readSession(sessionIdHash, projectId)).toBeUndefined();
    expect(await store.hasActiveProjectSessions(projectId)).toBe(false);
  });
});
