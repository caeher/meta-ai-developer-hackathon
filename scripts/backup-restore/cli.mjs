import { closeBackupClient, createBackup, loadLocalBackupConfig, restoreBackup } from "./core.mjs";

function optionsFrom(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error("backup_arguments_invalid");
    if (Object.hasOwn(result, key)) throw new Error("backup_arguments_invalid");
    result[key] = value;
    index += 1;
  }
  return result;
}

const [command, ...arguments_] = process.argv.slice(2);
let config;
try {
  config = loadLocalBackupConfig();
  if (command === "create" && arguments_.length === 0) {
    const result = await createBackup({
      client: config.s3,
      databaseName: config.databaseName,
      buckets: config.buckets,
      outputRoot: config.outputRoot,
      retentionDays: config.retentionDays,
      keyring: config.keyring,
    });
    console.log("Backup cifrado creado: " + result.folder);
    console.log("Postgres: " + result.databaseBytes + " bytes; objetos S3: " + result.objectCount + "; buckets: " + result.bucketCount + ".");
  } else if (command === "restore") {
    const args = optionsFrom(arguments_);
    if (!args["--backup-dir"] || !args["--database-name"] || !args["--bucket-private"] || !args["--bucket-public"]) {
      throw new Error("restore_requires_backup_database_and_buckets");
    }
    const result = await restoreBackup({
      client: config.s3,
      keyring: config.keyring,
      folder: args["--backup-dir"],
      targetDatabase: args["--database-name"],
      targetBuckets: { private: args["--bucket-private"], public: args["--bucket-public"] },
    });
    console.log("Restore completo en entorno vacío: " + result.databaseName + "; objetos S3: " + result.objectCount + ".");
  } else {
    throw new Error("backup_command_invalid");
  }
} catch (error) {
  const message = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : "backup_operation_failed";
  console.error(message);
  process.exitCode = 1;
} finally {
  if (config) await closeBackupClient(config);
}
