import { config as loadDotenv } from "dotenv";
import {
  isSafeMetaSmokeError,
  loadMetaConfig,
  MetaConfigurationError,
  parseMetaSmokeOptions,
  runMetaSmoke,
} from "@meta-game/meta";

function printUsage(): void {
  console.log("Usage: npm run meta:smoke [-- --tools] [--image]");
  console.log("  --tools  makes two token-billed Responses calls to verify function calling");
  console.log("  --image  makes a separately billable image-generation request; pricing can change");
}

async function main(): Promise<void> {
  let options: ReturnType<typeof parseMetaSmokeOptions>;
  try {
    options = parseMetaSmokeOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid smoke test options.");
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  if (options.checkTools) {
    console.log("Cost notice: --tools makes up to two token-billed requests using a synthetic function call.");
  }
  if (options.checkImage) {
    console.log("Cost notice: --image generates one image and may incur a separate charge; check Meta's current pricing before running.");
  }

  // Keep local credentials out of tracked files and console output. Ambient environment takes precedence.
  loadDotenv({ path: [".env.local", ".env"], quiet: true, override: false });

  try {
    const config = loadMetaConfig();
    const result = await runMetaSmoke(config, options);
    console.log("Meta API smoke test: passed");
    console.log(`Models available: ${result.modelIds.join(", ")}`);
    console.log(`Response ID: ${result.responseId}`);
    console.log(`Text: ${result.textPreview}`);
    if (result.toolResponseId) console.log(`Tool response ID: ${result.toolResponseId}`);
    if (result.imageResponseId) console.log(`Image response ID: ${result.imageResponseId}`);
  } catch (error) {
    if (error instanceof MetaConfigurationError) {
      console.error(`Meta configuration error: ${error.message}`);
    } else if (isSafeMetaSmokeError(error)) {
      console.error(`Meta smoke test failed: ${error.message}`);
    } else {
      console.error("Meta smoke test failed: unexpected error; details suppressed.");
    }
    process.exitCode = 1;
  }
}

void main().catch(() => {
  console.error("Meta smoke test failed: unexpected error; details suppressed.");
  process.exitCode = 1;
});
