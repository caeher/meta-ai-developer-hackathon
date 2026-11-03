import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { composeArguments, readLocalEnvironment, runDocker } from "./infra-common.mjs";
import {
  loadDatabaseEnvironment,
  loadLocalStorageEnvironment,
  repositoryRoot,
} from "./db-environment.mjs";

function runNodeScript(script, arguments_) {
  const result = spawnSync(process.execPath, [join(repositoryRoot, script), ...arguments_], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw new Error("No se pudo iniciar una verificación de integración.");
  return result.status ?? 1;
}

async function readSyntheticSeedCounts(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT
        (SELECT count(*) FROM users WHERE user_id IN ('user_fixtureAccountA001', 'user_fixtureAccountB001')) AS users,
        (SELECT count(*) FROM projects WHERE id IN ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202')) AS projects,
        (SELECT count(*) FROM messages WHERE id IN ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000302')) AS messages,
        (SELECT count(*) FROM runs WHERE id IN ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000402')) AS runs,
        (SELECT count(*) FROM run_events WHERE id IN ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000502')) AS events,
        (SELECT count(*) FROM sandboxes WHERE id IN ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000602')) AS sandboxes,
        (SELECT count(*) FROM usage_reservations WHERE id IN ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702')) AS reservations,
        (SELECT count(*) FROM usage_ledger WHERE idempotency_key IN ('fixture-ledger-user_fixtureAccountA001', 'fixture-ledger-user_fixtureAccountB001')) AS ledger
    `);
    return Object.values(result.rows[0] ?? {}).map(Number);
  } finally {
    await client.end();
  }
}

function runMcli(arguments_) {
  runDocker(
    composeArguments([
      "exec",
      "-T",
      "s3",
      "mcli",
      "--config-dir",
      "/tmp/forja-mcli-config",
      ...arguments_,
    ]),
    { quiet: true },
  );
}

function createPrivateTestBucket(bucket) {
  runMcli(["mb", "--ignore-existing", `local/${bucket}`]);
  try {
    runMcli(["anonymous", "set", "none", `local/${bucket}`]);
  } catch (error) {
    try {
      runMcli(["rb", "--force", `local/${bucket}`]);
    } catch {
      // The bucket name is unique to this run; a failed cleanup cannot touch another bucket.
    }
    throw error;
  }
}

let admin;
let databaseName;
let databaseCreated = false;
let temporaryBucket;
let bucketCreated = false;
let temporaryPublicationBucket;
let publicationBucketCreated = false;

try {
  loadDatabaseEnvironment();
  const localEnvironment = readLocalEnvironment();
  process.env.REDIS_URL = `redis://127.0.0.1:${localEnvironment.REDIS_PORT}`;
  loadLocalStorageEnvironment();
  temporaryBucket = `meta-game-itest-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  createPrivateTestBucket(temporaryBucket);
  bucketCreated = true;
  process.env.S3_BUCKET_PRIVATE = temporaryBucket;
  temporaryPublicationBucket = `meta-game-pub-itest-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  createPrivateTestBucket(temporaryPublicationBucket);
  publicationBucketCreated = true;
  process.env.S3_BUCKET_PUBLIC = temporaryPublicationBucket;
  process.env.PUBLISH_S3_ACCESS_KEY_ID = localEnvironment.MINIO_ROOT_USER;
  process.env.PUBLISH_S3_SECRET_ACCESS_KEY = localEnvironment.MINIO_ROOT_PASSWORD;
  process.env.PUBLISH_READ_ACCESS_KEY_ID = localEnvironment.MINIO_ROOT_USER;
  process.env.PUBLISH_READ_SECRET_ACCESS_KEY = localEnvironment.MINIO_ROOT_PASSWORD;
  process.env.PUBLICATION_S3_TEST_ENABLED = "1";
  const baseUrl = new URL(process.env.DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname.toLowerCase())) {
    throw new Error("test:integration solo conecta a PostgreSQL local; DATABASE_URL no se registra.");
  }
  databaseName = `meta_game_itest_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  const testUrl = new URL(process.env.DATABASE_URL);
  testUrl.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = testUrl.toString();
  const migrateStatus = runNodeScript("scripts/db-migrate.mjs", []);
  if (migrateStatus !== 0) {
    process.exitCode = migrateStatus;
  } else {
    const repeatMigrationStatus = runNodeScript("scripts/db-migrate.mjs", []);
    if (repeatMigrationStatus !== 0) {
      process.exitCode = repeatMigrationStatus;
    } else {
      const firstSeedStatus = runNodeScript("scripts/db-seed.mjs", []);
      if (firstSeedStatus !== 0) {
        process.exitCode = firstSeedStatus;
      } else {
        const firstCounts = await readSyntheticSeedCounts(process.env.DATABASE_URL);
        const secondSeedStatus = runNodeScript("scripts/db-seed.mjs", []);
        if (secondSeedStatus !== 0) {
          process.exitCode = secondSeedStatus;
        } else {
          const secondCounts = await readSyntheticSeedCounts(process.env.DATABASE_URL);
          if (firstCounts.length !== 8 || firstCounts.some((count) => count !== 2) || secondCounts.some((count, index) => count !== firstCounts[index])) {
            throw new Error("db:seed no fue idempotente en la base temporal.");
          }
          process.env.PERSISTENCE_TEST_ENABLED = "1";
          // Los archivos de integración comparten el mismo PostgreSQL/Redis/Silo temporales.
          // Ejecutarlos en paralelo puede intercalar cuotas y locks entre fixtures aislados.
          process.exitCode = runNodeScript("node_modules/vitest/vitest.mjs", ["run", "--maxWorkers=1", "tests/integration"]);
        }
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "No se pudo preparar la integración local.");
  process.exitCode = 1;
} finally {
  if (databaseCreated && admin) {
    try {
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } catch {
      console.error("No se pudo eliminar la base temporal de integración; elimínala por su ID de prueba.");
      process.exitCode = 1;
    }
  }
  if (admin) await admin.end();
  if (bucketCreated && temporaryBucket) {
    try {
      runMcli(["rb", "--force", `local/${temporaryBucket}`]);
    } catch {
      console.error("No se pudo eliminar el bucket S3 temporal de integración; elimínalo en el entorno local.");
      process.exitCode = 1;
    }
  }
  if (publicationBucketCreated && temporaryPublicationBucket) {
    try {
      runMcli(["rb", "--force", `local/${temporaryPublicationBucket}`]);
    } catch {
      console.error("No se pudo eliminar el bucket público temporal de integración; elimínalo en el entorno local.");
      process.exitCode = 1;
    }
  }
}
