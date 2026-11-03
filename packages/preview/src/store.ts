import { createHash } from "node:crypto";
import Redis from "ioredis";
import { PreviewSessionSchema, type PreviewSession } from "@meta-game/contracts";

export type PreviewStore = Readonly<{
  ping?(): Promise<boolean>;
  getProjectEpoch(projectId: string): Promise<number>;
  createSessionFromGrant(input: {
    projectId: string;
    grantId: string;
    epoch: number;
    grantTtlSeconds: number;
    sessionIdHash: string;
    session: PreviewSession;
    sessionTtlSeconds: number;
  }): Promise<boolean>;
  readSession(sessionIdHash: string, projectId: string, nowSeconds?: number): Promise<PreviewSession | undefined>;
  hasActiveProjectSessions(projectId: string, nowSeconds?: number): Promise<boolean>;
  revokeProject(projectId: string): Promise<number>;
  allowRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  subscribeRevocations(listener: (projectId: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}>;

export function hashPreviewSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function projectEpochKey(projectId: string): string { return `preview:epoch:${projectId}`; }
function usedGrantKey(grantId: string): string { return `preview:grant:${grantId}`; }
function sessionKey(sessionIdHash: string): string { return `preview:session:${sessionIdHash}`; }
function projectSessionsKey(projectId: string): string { return `preview:project-sessions:${projectId}`; }

const createSessionScript = `
local epoch = tonumber(redis.call('GET', KEYS[1]) or '0')
if epoch ~= tonumber(ARGV[1]) then return 0 end
if redis.call('EXISTS', KEYS[3]) == 1 then return -2 end
local grant = redis.call('SET', KEYS[2], '1', 'EX', ARGV[2], 'NX')
if not grant then return -1 end
local session = redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4], 'NX')
if not session then redis.call('DEL', KEYS[2]); return -2 end
redis.call('ZADD', KEYS[4], ARGV[5], ARGV[6])
redis.call('PEXPIRE', KEYS[4], tonumber(ARGV[4]) * 1000)
return 1
`;

const readSessionScript = `
local session = redis.call('GET', KEYS[1])
if not session then return nil end
local epoch = redis.call('GET', KEYS[2]) or '0'
return { session, epoch }
`;

const revokeProjectScript = `
local epoch = redis.call('INCR', KEYS[1])
redis.call('PUBLISH', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
return epoch
`;

const rateLimitScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export function createRedisPreviewStore(redisUrl: string): PreviewStore {
  const parsedUrl = new URL(redisUrl);
  if (!new Set(["redis:", "rediss:"]).has(parsedUrl.protocol)) throw new Error("preview_store_configuration_invalid");
  const client = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 5_000 });
  let connectPromise: Promise<void> | undefined;
  const ensureConnected = async (connection = client): Promise<void> => {
    if (String(connection.status) === "ready") return;
    if (!connectPromise && connection === client) {
      connectPromise = connection.connect().finally(() => { connectPromise = undefined; });
    }
    if (connection === client && connectPromise) await connectPromise;
    else if (connection.status === "wait") await connection.connect();
    if (String(connection.status) !== "ready") throw new Error("preview_store_unavailable");
  };

  return {
    async ping() {
      try {
        await ensureConnected();
        return (await client.ping()) === "PONG";
      } catch { return false; }
    },
    async getProjectEpoch(projectId) {
      await ensureConnected();
      const value = await client.get(projectEpochKey(projectId));
      const epoch = value === null ? 0 : Number(value);
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("preview_store_state_invalid");
      return epoch;
    },
    async createSessionFromGrant(input) {
      await ensureConnected();
      const result = Number(await client.eval(createSessionScript, 4,
        projectEpochKey(input.projectId), usedGrantKey(input.grantId), sessionKey(input.sessionIdHash), projectSessionsKey(input.projectId),
        String(input.epoch), String(input.grantTtlSeconds), JSON.stringify(input.session), String(input.sessionTtlSeconds),
        String(input.session.expiresAt), input.sessionIdHash));
      return result === 1;
    },
    async readSession(sessionIdHash, projectId, nowSeconds = Math.floor(Date.now() / 1000)) {
      await ensureConnected();
      const result = await client.eval(readSessionScript, 2, sessionKey(sessionIdHash), projectEpochKey(projectId)) as unknown;
      if (!Array.isArray(result) || result.length !== 2 || typeof result[0] !== "string" || typeof result[1] !== "string") return undefined;
      try {
        const session = PreviewSessionSchema.parse(JSON.parse(result[0]));
        const epoch = Number(result[1]);
        if (!Number.isSafeInteger(epoch) || session.projectId !== projectId || session.epoch !== epoch || session.expiresAt <= nowSeconds) return undefined;
        return session;
      } catch { return undefined; }
    },
    async hasActiveProjectSessions(projectId, nowSeconds = Math.floor(Date.now() / 1000)) {
      if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return false;
      await ensureConnected();
      const key = projectSessionsKey(projectId);
      await client.zremrangebyscore(key, "-inf", String(nowSeconds));
      return (await client.zcard(key)) > 0;
    },
    async revokeProject(projectId) {
      await ensureConnected();
      return Number(await client.eval(revokeProjectScript, 3, projectEpochKey(projectId), `preview:revoke:${projectId}`, projectSessionsKey(projectId), projectId));
    },
    async allowRateLimit(key, limit, windowSeconds) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000 ||
        !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400) return false;
      await ensureConnected();
      const count = Number(await client.eval(rateLimitScript, 1, `preview:rate:${key}`, String(windowSeconds)));
      return count <= limit;
    },
    async subscribeRevocations(listener) {
      const subscriber = client.duplicate({ lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 5_000 });
      await ensureConnected(subscriber);
      const pattern = "preview:revoke:*";
      subscriber.on("pmessage", (_pattern: string, channel: string, projectId: string) => {
        if (channel === `preview:revoke:${projectId}` && /^[0-9a-f-]{36}$/i.test(projectId)) listener(projectId);
      });
      await subscriber.psubscribe(pattern);
      return async () => { if (subscriber.status !== "end") await subscriber.quit(); };
    },
    async close() {
      if (client.status === "end") return;
      if (client.status === "wait") client.disconnect();
      else await client.quit();
    },
  };
}
