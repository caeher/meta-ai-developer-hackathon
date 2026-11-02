import { verifySkillsBundle, writeSkillsManifest } from "../packages/skills/src/verify.js";

const rootDir = process.cwd();

async function main(): Promise<void> {
  if (process.argv.includes("--write-manifest")) {
    const count = await writeSkillsManifest(rootDir);
    process.stdout.write(`Wrote pinned skills manifest (${count} files).\n`);
  } else {
    const result = await verifySkillsBundle(rootDir);
    if (result.valid) {
      process.stdout.write(`Skills verified: ${result.fileCount} vendored files at the pinned upstream SHA.\n`);
    } else {
      for (const error of result.errors) process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Skills verification failed."}\n`);
  process.exitCode = 1;
});
