import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { decodeVersionSnapshot, snapshotBytes, snapshotObjectKey } from "@meta-game/storage";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { closeBackupClient, createBackup, loadLocalBackupConfig, restoreBackup } from "./core.mjs";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const sourceDatabase = "mg_backup_src_" + suffix;
const targetDatabase = "mg_backup_dst_" + suffix;
const sourceBuckets = { private: "mg-bkp-src-p-" + suffix, public: "mg-bkp-src-u-" + suffix };
const targetBuckets = { private: "mg-bkp-dst-p-" + suffix, public: "mg-bkp-dst-u-" + suffix };
const root = await mkdtemp(join(tmpdir(), "forja-backup-acceptance-"));
const fixtureBody = Buffer.from("synthetic private asset fixture", "utf8");
const fixtureAssetKey = "acceptance/asset-fixture.txt";
const encryptionKey = randomBytes(32);
const keyId = "acceptance-" + suffix;
const keyring = { activeKeyId: keyId, activeKey: encryptionKey, keys: new Map([[keyId, encryptionKey]]) };
const clientConfig = loadLocalBackupConfig({ keyring });
const baseDatabaseUrl = new URL(process.env.DATABASE_URL);
const ownerUserId = randomUUID();
const projectId = randomUUID();
const versionId = randomUUID();
const assetId = randomUUID();
const snapshotKey = snapshotObjectKey({ ownerUserId, projectId, versionId });
const gameSpec = {
  schemaVersion: 1,
  genre: "platformer",
  intent: "create",
  objective: "Synthetic backup recovery acceptance",
  changes: [],
  controls: { movement: "arrows", action: "space", touch: true },
};
const snapshotFiles = [
  { path: "package.json", encoding: "utf8", content: JSON.stringify({ name: "recovery-fixture", version: "1.0.0" }), bytes: 0, sha256: "" },
  { path: "src/game/project-spec.json", encoding: "utf8", content: JSON.stringify(gameSpec), bytes: 0, sha256: "" },
].map((file) => {
  const bytes = Buffer.byteLength(file.content, "utf8");
  return { ...file, bytes, sha256: createHash("sha256").update(file.content).digest("hex") };
});
const snapshotTotalBytes = snapshotFiles.reduce((total, file) => total + file.bytes, 0);
const snapshot = {
  schemaVersion: 1,
  projectId,
  versionId,
  runId: null,
  parentVersionId: null,
  gameSpec,
  verification: { status: "passed", checks: [{ check: "backup_recovery", status: "passed", summary: "Synthetic snapshot accepted." }] },
  files: snapshotFiles,
  totalBytes: snapshotTotalBytes,
};
const snapshotBody = Buffer.from(snapshotBytes(snapshot));
const assetSha256 = createHash("sha256").update(fixtureBody).digest("hex");
const snapshotSha256 = createHash("sha256").update(snapshotBody).digest("hex");
let admin;
let sourceCreated = false;
let targetCreated = false;
const createdBuckets = [];

function databaseUrl(name) {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/" + name;
  return url.toString();
}

async function removeBucket(bucket) {
  let token;
  do {
    const listing = await clientConfig.s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    const objects = (listing.Contents ?? []).flatMap((item) => typeof item.Key === "string" ? [{ Key: item.Key }] : []);
    if (objects.length) await clientConfig.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    token = listing.IsTruncated ? listing.NextContinuationToken : undefined;
  } while (token);
  await clientConfig.s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}

const started = Date.now();
let backupSeconds = 0;
let restoreSeconds = 0;
try {
  admin = new pg.Client({ connectionString: baseDatabaseUrl.toString() });
  await admin.connect();
  await admin.query("CREATE DATABASE \"" + sourceDatabase + "\"");
  sourceCreated = true;
  const migrationPool = new pg.Pool({ connectionString: databaseUrl(sourceDatabase) });
  try {
    await migrate(drizzle(migrationPool), { migrationsFolder: fileURLToPath(new URL("../../packages/db/migrations/", import.meta.url)) });
  } finally { await migrationPool.end(); }
  const source = new pg.Client({ connectionString: databaseUrl(sourceDatabase) });
  await source.connect();
  try {
    await source.query("INSERT INTO users (id, user_id, email) VALUES ($1, $2, $3)", [ownerUserId, "fixture_" + suffix, "fixture-" + suffix + "@example.invalid"]);
    await source.query("INSERT INTO projects (id, owner_user_id, name) VALUES ($1, $2, $3)", [projectId, ownerUserId, "Synthetic recovery project"]);
    await source.query(
      "INSERT INTO versions (id, owner_user_id, project_id, version_number, snapshot_key, sha256, size_bytes, manifest, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready')",
      [versionId, ownerUserId, projectId, 1, snapshotKey, snapshotSha256, snapshotBody.byteLength, snapshot],
    );
    await source.query(
      "INSERT INTO assets (id, owner_user_id, project_id, object_key, content_type, size_bytes, sha256, status, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready', $8)",
      [assetId, ownerUserId, projectId, fixtureAssetKey, "text/plain", fixtureBody.byteLength, assetSha256, { kind: "acceptance-fixture" }],
    );
  } finally { await source.end(); }
  for (const bucket of Object.values(sourceBuckets)) {
    await clientConfig.s3.send(new CreateBucketCommand({ Bucket: bucket }));
    createdBuckets.push(bucket);
  }
  await clientConfig.s3.send(new PutObjectCommand({ Bucket: sourceBuckets.private, Key: fixtureAssetKey, Body: fixtureBody, ContentType: "text/plain" }));
  await clientConfig.s3.send(new PutObjectCommand({ Bucket: sourceBuckets.private, Key: snapshotKey, Body: snapshotBody, ContentType: "application/gzip" }));

  const backupStart = Date.now();
  const backup = await createBackup({
    client: clientConfig.s3,
    databaseName: sourceDatabase,
    buckets: sourceBuckets,
    outputRoot: root,
    retentionDays: 30,
    keyring,
  });
  backupSeconds = (Date.now() - backupStart) / 1_000;

  const restoreStart = Date.now();
  const restored = await restoreBackup({
    client: clientConfig.s3,
    keyring,
    folder: backup.folder,
    targetDatabase,
    targetBuckets,
  });
  targetCreated = true;
  restoreSeconds = (Date.now() - restoreStart) / 1_000;
  createdBuckets.push(...Object.values(targetBuckets));

  const target = new pg.Client({ connectionString: databaseUrl(targetDatabase) });
  await target.connect();
  try {
    const rows = await target.query(
      "SELECT p.name, v.version_number, v.snapshot_key, v.sha256 AS snapshot_sha256, a.object_key, a.sha256 AS asset_sha256 FROM projects p JOIN versions v ON v.owner_user_id = p.owner_user_id AND v.project_id = p.id JOIN assets a ON a.owner_user_id = p.owner_user_id AND a.project_id = p.id WHERE p.id = $1 AND v.id = $2 AND a.id = $3",
      [projectId, versionId, assetId],
    );
    if (rows.rowCount !== 1 || rows.rows[0]?.name !== "Synthetic recovery project" || rows.rows[0]?.version_number !== 1 ||
        rows.rows[0]?.snapshot_key !== snapshotKey || rows.rows[0]?.snapshot_sha256 !== snapshotSha256 ||
        rows.rows[0]?.object_key !== fixtureAssetKey || rows.rows[0]?.asset_sha256 !== assetSha256) {
      throw new Error("backup_acceptance_database_mismatch");
    }
  } finally { await target.end(); }
  const assetObject = await clientConfig.s3.send(new GetObjectCommand({ Bucket: targetBuckets.private, Key: fixtureAssetKey }));
  const assetBytes = await assetObject.Body?.transformToByteArray();
  if (!assetBytes || !Buffer.from(assetBytes).equals(fixtureBody)) throw new Error("backup_acceptance_s3_mismatch");
  const snapshotObject = await clientConfig.s3.send(new GetObjectCommand({ Bucket: targetBuckets.private, Key: snapshotKey }));
  const restoredSnapshotBytes = await snapshotObject.Body?.transformToByteArray();
  if (!restoredSnapshotBytes || !Buffer.from(restoredSnapshotBytes).equals(snapshotBody)) throw new Error("backup_acceptance_s3_mismatch");
  const openedSnapshot = decodeVersionSnapshot(restoredSnapshotBytes);
  if (openedSnapshot.projectId !== projectId || openedSnapshot.versionId !== versionId || openedSnapshot.files.length !== 2) {
    throw new Error("backup_acceptance_snapshot_mismatch");
  }
  if (restored.objectCount !== 2 || backup.objectCount !== 2) throw new Error("backup_acceptance_object_count_mismatch");
  console.log("Compose backup/restore PostgreSQL + Silo: OK; proyecto=1, version=1, asset=1, objetos=2; backup=" + backupSeconds.toFixed(3) + "s; restore=" + restoreSeconds.toFixed(3) + "s; total=" + ((Date.now() - started) / 1_000).toFixed(3) + "s.");
} catch (error) {
  const message = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : "backup_acceptance_failed";
  console.error(message);
  process.exitCode = 1;
} finally {
  for (const bucket of createdBuckets.reverse()) await removeBucket(bucket).catch(() => { process.exitCode = 1; });
  if (targetCreated && admin) await admin.query("DROP DATABASE IF EXISTS \"" + targetDatabase + "\" WITH (FORCE)").catch(() => { process.exitCode = 1; });
  if (sourceCreated && admin) await admin.query("DROP DATABASE IF EXISTS \"" + sourceDatabase + "\" WITH (FORCE)").catch(() => { process.exitCode = 1; });
  if (admin) await admin.end();
  await rm(root, { recursive: true, force: true });
  await closeBackupClient(clientConfig);
}
