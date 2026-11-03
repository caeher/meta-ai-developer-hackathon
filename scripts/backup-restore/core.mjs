import { appendFile, chmod, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import "dotenv/config";
import { loadDatabaseEnvironment } from "../db-environment.mjs";
import { pipeline } from "node:stream/promises";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { composeArguments, ensureLocalEnvironmentFile, readLocalEnvironment } from "../infra-common.mjs";

const formatVersion = 1;
const magic = Buffer.from([0x4d, 0x47, 0x42, 0x31]);
const databaseNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const bucketNamePattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const objectKeyLimit = 1_024;
const writerServices = new Set(["web", "worker", "publishing-origin", "sandbox-controller"]);

function assertSafeDatabaseName(value) {
  if (!databaseNamePattern.test(value)) throw new Error("backup_database_name_invalid");
  return value;
}

function assertSafeBucket(value) {
  if (!bucketNamePattern.test(value)) throw new Error("backup_bucket_name_invalid");
  return value;
}

function readKeyring(rawValue, activeKeyId) {
  let parsed;
  try { parsed = JSON.parse(rawValue); } catch { throw new Error("backup_keyring_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("backup_keyring_invalid");
  const result = new Map();
  for (const [keyId, rawKey] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || typeof rawKey !== "string") throw new Error("backup_keyring_invalid");
    const key = Buffer.from(rawKey, "base64");
    if (key.length !== 32 || key.toString("base64") !== rawKey) throw new Error("backup_key_invalid");
    result.set(keyId, key);
  }
  const active = result.get(activeKeyId);
  if (!active) throw new Error("backup_active_key_missing");
  return { keys: result, activeKeyId, activeKey: active };
}

function checkedBackupDir(rawPath) {
  const absolute = resolve(rawPath);
  if (absolute === resolve(absolute, "..") || absolute.endsWith(sep)) throw new Error("backup_directory_invalid");
  return absolute;
}

function s3ClientFromEnvironment() {
  const endpoint = new URL(process.env.S3_ENDPOINT);
  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(endpoint.hostname.toLowerCase()) ||
      !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("backup_s3_endpoint_must_be_local");
  }
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("backup_s3_credentials_missing");
  return new S3Client({
    endpoint: endpoint.origin,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function loadLocalBackupConfig(options = {}) {
  ensureLocalEnvironmentFile();
  loadDatabaseEnvironment();
  const environment = readLocalEnvironment();
  const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgresql://placeholder/placeholder");
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!loopbackHosts.has(databaseUrl.hostname.toLowerCase()) || Number(databaseUrl.port || "5432") !== Number(environment.POSTGRES_PORT)) {
    throw new Error("backup_database_must_be_local_compose");
  }
  if (decodeURIComponent(databaseUrl.pathname.slice(1)) !== environment.POSTGRES_DB ||
      decodeURIComponent(databaseUrl.username) !== environment.POSTGRES_USER) throw new Error("backup_database_must_match_compose");
  process.env.S3_ENDPOINT = "http://127.0.0.1:" + environment.S3_API_PORT;
  process.env.S3_REGION = "us-east-1";
  process.env.S3_ACCESS_KEY_ID = environment.MINIO_ROOT_USER;
  process.env.S3_SECRET_ACCESS_KEY = environment.MINIO_ROOT_PASSWORD;
  process.env.S3_BUCKET_PRIVATE = environment.S3_BUCKET_PRIVATE;
  process.env.S3_BUCKET_PUBLIC = environment.S3_BUCKET_PUBLIC;
  const keyring = options.keyring ?? readKeyring(environment.BACKUP_ENCRYPTION_KEYS, environment.BACKUP_KEY_ID);
  return {
    environment,
    databaseName: assertSafeDatabaseName(environment.POSTGRES_DB),
    buckets: {
      private: assertSafeBucket(environment.S3_BUCKET_PRIVATE),
      public: assertSafeBucket(environment.S3_BUCKET_PUBLIC),
    },
    outputRoot: checkedBackupDir(environment.BACKUP_DIR),
    retentionDays: environment.BACKUP_RETENTION_DAYS,
    keyring,
    s3: s3ClientFromEnvironment(),
  };
}

function composeAllProfiles(extra) {
  return composeArguments([
    "--profile", "web", "--profile", "worker", "--profile", "preview", "--profile", "publishing", "--profile", "local-domains",
    ...extra,
  ]);
}

function readComposeOutput(arguments_) {
  const result = spawnSync(process.platform === "win32" ? "docker.exe" : "docker", composeAllProfiles(arguments_), {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) throw new Error("backup_compose_query_failed");
  return result.stdout;
}

function runCompose(arguments_, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.platform === "win32" ? "docker.exe" : "docker", composeAllProfiles(arguments_), {
      windowsHide: true,
      shell: false,
      stdio: options.stdin ? ["pipe", "ignore", "ignore"] : ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => reject(new Error("backup_compose_command_failed")));
    child.once("close", (code) => code === 0 ? resolvePromise(child) : reject(new Error("backup_compose_command_failed")));
    if (options.stdin) options.stdin.pipe(child.stdin);
  });
}

async function pauseWriters() {
  const running = readComposeOutput(["ps", "--services", "--status", "running"]).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const stopped = running.filter((service) => writerServices.has(service));
  const first = stopped.filter((service) => service !== "worker");
  try {
    if (first.length) await runCompose(["stop", "--timeout", "30", ...first]);
    if (stopped.includes("worker")) await runCompose(["stop", "--timeout", "660", "worker"]);
  } catch {
    await resumeWriters(stopped).catch(() => undefined);
    throw new Error("backup_writer_pause_failed");
  }
  return stopped;
}

async function resumeWriters(stopped) {
  if (stopped.length) await runCompose(["start", ...stopped]);
}

function spawnPgDump(databaseName) {
  assertSafeDatabaseName(databaseName);
  const shellCommand = 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump --username "$POSTGRES_USER" --dbname "$1" --format=custom --no-owner --no-acl';
  return spawn(process.platform === "win32" ? "docker.exe" : "docker", composeAllProfiles([
    "exec", "-T", "postgres", "sh", "-c", shellCommand, "pg_dump", databaseName,
  ]), { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] });
}

function spawnPgRestore(databaseName, dumpPath) {
  assertSafeDatabaseName(databaseName);
  const shellCommand = 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_restore --username "$POSTGRES_USER" --dbname "$1" --exit-on-error --no-owner --no-acl';
  const child = spawn(process.platform === "win32" ? "docker.exe" : "docker", composeAllProfiles([
    "exec", "-T", "postgres", "sh", "-c", shellCommand, "pg_restore", databaseName,
  ]), { windowsHide: true, shell: false, stdio: ["pipe", "ignore", "ignore"] });
  const completion = new Promise((resolvePromise, reject) => {
    child.once("error", () => reject(new Error("restore_postgres_failed")));
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error("restore_postgres_failed")));
  });
  return pipeline(createReadStream(dumpPath), child.stdin).then(() => completion);
}

function spawnDatabaseCommand(command, databaseName) {
  assertSafeDatabaseName(databaseName);
  const shellCommand = 'PGPASSWORD="$POSTGRES_PASSWORD" exec ' + command + ' --username "$POSTGRES_USER" "$1"';
  return runCompose(["exec", "-T", "postgres", "sh", "-c", shellCommand, command, databaseName]);
}

function hashTransform() {
  const hash = createHash("sha256");
  let bytes = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      hash.update(value);
      callback(null, value);
    },
  });
  return { transform, digest: () => hash.digest("hex"), bytes: () => bytes };
}

async function encryptReadable(source, targetPath, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const tally = hashTransform();
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.concat([magic, iv]), { mode: 0o600 });
  try {
    await pipeline(source, tally.transform, cipher, createWriteStream(targetPath, { flags: "a", mode: 0o600 }));
    await appendFile(targetPath, cipher.getAuthTag(), { mode: 0o600 });
  } catch {
    await rm(targetPath, { force: true });
    throw new Error("backup_encryption_failed");
  }
  return { bytes: tally.bytes(), sha256: tally.digest() };
}

async function decryptFile(sourcePath, targetPath, key, expected = undefined) {
  const sourceStat = await stat(sourcePath);
  if (sourceStat.size < 32) throw new Error("backup_ciphertext_invalid");
  const handle = await open(sourcePath, "r");
  let header;
  let tag;
  try {
    header = Buffer.alloc(16);
    tag = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, tag.length, sourceStat.size - tag.length);
  } finally { await handle.close(); }
  if (!header.subarray(0, 4).equals(magic)) throw new Error("backup_ciphertext_invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(4));
  decipher.setAuthTag(tag);
  const tally = hashTransform();
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    const start = 16;
    const end = sourceStat.size - 17;
    const input = end < start ? Readable.from([]) : createReadStream(sourcePath, { start, end });
    await pipeline(input, decipher, tally.transform, createWriteStream(targetPath, { mode: 0o600 }));
  } catch {
    await rm(targetPath, { force: true });
    throw new Error("backup_authentication_failed");
  }
  const result = { bytes: tally.bytes(), sha256: tally.digest() };
  if (expected && (result.bytes !== expected.bytes || result.sha256 !== expected.sha256)) {
    await rm(targetPath, { force: true });
    throw new Error("backup_checksum_mismatch");
  }
  return result;
}

async function encryptBuffer(value, targetPath, key) {
  await encryptReadable(Readable.from([value]), targetPath, key);
}

function toReadable(body) {
  if (body instanceof Readable) return body;
  if (body && typeof body.transformToWebStream === "function") return Readable.fromWeb(body.transformToWebStream());
  return Readable.from(body);
}

async function listBucket(client, bucket) {
  const objects = [];
  let continuationToken;
  do {
    const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    for (const item of result.Contents ?? []) {
      if (typeof item.Key !== "string" || item.Key.length > objectKeyLimit) throw new Error("backup_s3_object_key_invalid");
      objects.push({ key: item.Key, bytes: Number(item.Size ?? 0), contentType: "application/octet-stream" });
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects.sort((left, right) => left.key.localeCompare(right.key));
}

async function removeEmptyBackup(folder) {
  await rm(folder, { recursive: true, force: true });
}

async function pruneBackups(root, retentionDays) {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("forja-backup-")) continue;
    const path = resolve(root, entry.name);
    if (!path.startsWith(resolve(root) + sep)) continue;
    const details = await stat(path).catch(() => undefined);
    if (details && details.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
  }
}

export async function createBackup(input) {
  const { client, keyring } = input;
  const databaseName = assertSafeDatabaseName(input.databaseName);
  const buckets = {
    private: assertSafeBucket(input.buckets.private),
    public: assertSafeBucket(input.buckets.public),
  };
  const outputRoot = checkedBackupDir(input.outputRoot);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(outputRoot, 0o700);
  const backupId = "forja-backup-" + new Date().toISOString().replaceAll(/[^0-9TZ]/g, "") + "-" + randomBytes(4).toString("hex");
  const folder = join(outputRoot, backupId);
  const stopped = input.pauseWriters === false ? [] : await pauseWriters();
  let complete = false;
  try {
    await mkdir(join(folder, "objects"), { recursive: true, mode: 0o700 });
    const dumpProcess = spawnPgDump(databaseName);
    const dumpCompletion = new Promise((resolvePromise, reject) => {
      dumpProcess.once("error", () => reject(new Error("backup_postgres_dump_failed")));
      dumpProcess.once("close", resolvePromise);
    });
    const dump = await encryptReadable(dumpProcess.stdout, join(folder, "postgres.dump.enc"), keyring.activeKey);
    const dumpCode = await dumpCompletion;
    if (dumpCode !== 0 || dump.bytes === 0) throw new Error("backup_postgres_dump_failed");
    const manifest = { formatVersion, createdAt: new Date().toISOString(), keyId: keyring.activeKeyId, databaseName,
      postgres: { file: "postgres.dump.enc", ...dump }, buckets: [] };
    let objectIndex = 0;
    for (const kind of ["private", "public"]) {
      const bucket = buckets[kind];
      const objects = await listBucket(client, bucket);
      const manifestObjects = [];
      for (const object of objects) {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }));
        if (!response.Body) throw new Error("backup_s3_object_missing");
        const file = "objects/object-" + String(objectIndex).padStart(8, "0") + ".enc";
        const encrypted = await encryptReadable(toReadable(response.Body), join(folder, file), keyring.activeKey);
        if (encrypted.bytes !== object.bytes) throw new Error("backup_s3_object_changed");
        manifestObjects.push({ key: object.key, file, ...encrypted, contentType: response.ContentType ?? object.contentType });
        objectIndex += 1;
      }
      manifest.buckets.push({ kind, objects: manifestObjects });
    }
    await encryptBuffer(Buffer.from(JSON.stringify(manifest), "utf8"), join(folder, "manifest.enc"), keyring.activeKey);
    await writeFile(join(folder, "format.json"), JSON.stringify({ formatVersion, keyId: keyring.activeKeyId, cipher: "aes-256-gcm" }) + "\n", { mode: 0o600 });
    complete = true;
    await pruneBackups(outputRoot, input.retentionDays ?? 30);
    return { folder, databaseBytes: dump.bytes, objectCount: objectIndex, bucketCount: 2, createdAt: manifest.createdAt };
  } finally {
    if (!complete) await removeEmptyBackup(folder);
    await resumeWriters(stopped);
  }
}

async function bucketExists(client, bucket) {
  try { await client.send(new HeadBucketCommand({ Bucket: bucket })); return true; }
  catch { return false; }
}

async function ensureBucketAbsent(client, bucket) {
  if (await bucketExists(client, bucket)) throw new Error("restore_target_bucket_must_not_exist");
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
}

async function deleteBucketContents(client, bucket) {
  let continuationToken;
  do {
    const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
    const objects = (result.Contents ?? []).flatMap((item) => typeof item.Key === "string" ? [{ Key: item.Key }] : []);
    if (objects.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

export async function restoreBackup(input) {
  const folder = resolve(input.folder);
  const metadata = JSON.parse(await readFile(join(folder, "format.json"), "utf8"));
  if (metadata.formatVersion !== formatVersion || metadata.cipher !== "aes-256-gcm" || typeof metadata.keyId !== "string") {
    throw new Error("backup_format_unsupported");
  }
  const key = input.keyring.keys.get(metadata.keyId);
  if (!key) throw new Error("backup_decryption_key_missing");
  const manifestPath = join(tmpdir(), "forja-restore-manifest-" + randomBytes(8).toString("hex"));
  await decryptFile(join(folder, "manifest.enc"), manifestPath, key);
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  finally { await rm(manifestPath, { force: true }); }
  if (!manifest || manifest.formatVersion !== formatVersion || manifest.keyId !== metadata.keyId ||
      !Array.isArray(manifest.buckets) || !manifest.postgres || manifest.postgres.file !== "postgres.dump.enc") {
    throw new Error("backup_manifest_invalid");
  }
  const targetDatabase = assertSafeDatabaseName(input.targetDatabase);
  const targetBuckets = { private: assertSafeBucket(input.targetBuckets.private), public: assertSafeBucket(input.targetBuckets.public) };
  if (new Set(Object.values(targetBuckets)).size !== 2) throw new Error("restore_target_buckets_must_be_distinct");
  const tempDump = join(tmpdir(), "forja-restore-pg-" + randomBytes(8).toString("hex"));
  const tempObjects = [];
  const createdBuckets = [];
  let databaseCreated = false;
  try {
    await decryptFile(join(folder, manifest.postgres.file), tempDump, key, manifest.postgres);
    await spawnDatabaseCommand("createdb", targetDatabase);
    databaseCreated = true;
    await spawnPgRestore(targetDatabase, tempDump);
    for (const entry of manifest.buckets) {
      if (!entry || !["private", "public"].includes(entry.kind) || !Array.isArray(entry.objects)) throw new Error("backup_manifest_invalid");
      const targetBucket = targetBuckets[entry.kind];
      await ensureBucketAbsent(input.client, targetBucket);
      createdBuckets.push(targetBucket);
      for (const object of entry.objects) {
        if (!object || typeof object.key !== "string" || object.key.length > objectKeyLimit ||
            typeof object.file !== "string" || !/^objects\/object-\d{8}\.enc$/.test(object.file) ||
            !Number.isSafeInteger(object.bytes) || object.bytes < 0 || !/^[a-f0-9]{64}$/.test(object.sha256)) {
          throw new Error("backup_manifest_invalid");
        }
        const plainPath = join(tmpdir(), "forja-restore-object-" + randomBytes(8).toString("hex"));
        tempObjects.push(plainPath);
        await decryptFile(join(folder, object.file), plainPath, key, object);
        const result = await input.client.send(new PutObjectCommand({
          Bucket: targetBucket,
          Key: object.key,
          Body: createReadStream(plainPath),
          ContentLength: object.bytes,
          ContentType: typeof object.contentType === "string" && object.contentType.length <= 128 ? object.contentType : "application/octet-stream",
        }));
        if (result.$metadata.httpStatusCode !== 200) throw new Error("restore_s3_write_failed");
        await rm(plainPath, { force: true });
        tempObjects.pop();
      }
    }
    return { databaseName: targetDatabase, privateBucket: targetBuckets.private, publicBucket: targetBuckets.public,
      objectCount: manifest.buckets.reduce((total, bucket) => total + bucket.objects.length, 0), createdAt: manifest.createdAt };
  } catch (error) {
    if (databaseCreated) await spawnDatabaseCommand("dropdb", targetDatabase).catch(() => undefined);
    for (const bucket of createdBuckets.reverse()) await deleteBucketContents(input.client, bucket).catch(() => undefined);
    throw error;
  } finally {
    await rm(tempDump, { force: true });
    await Promise.all(tempObjects.map((path) => rm(path, { force: true })));
  }
}

export async function closeBackupClient(config) {
  await config.s3.destroy();
}

