import { runIssue37DockerPreview } from "../tests/assets/issue-37-docker-preview";

type EncodedFile = readonly [string, string];

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const value: unknown = JSON.parse(await readInput());
  if (!Array.isArray(value)) throw new Error("issue_37_preview_input_invalid");
  const entries = value as EncodedFile[];
  if (entries.length < 1 || entries.length > 128 || entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 ||
      typeof entry[0] !== "string" || typeof entry[1] !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry[1]))) {
    throw new Error("issue_37_preview_input_invalid");
  }
  const files = new Map(entries.map(([path, bytes]) => [path, Buffer.from(bytes, "base64")]));
  const report = await runIssue37DockerPreview(files);
  process.stdout.write(`ISSUE37_DOCKER_PREVIEW_REPORT=${JSON.stringify(report)}\n`);
}

void main().catch((error: unknown) => {
  const structured = error as Error & { code?: unknown; diagnostic?: unknown };
  const candidate = error instanceof Error && "code" in error ? String(structured.code) :
    error instanceof Error ? error.message : "issue_37_preview_failed";
  const safeCode = /^[a-z][a-z0-9_]{0,79}$/.test(candidate) ? candidate : "issue_37_preview_failed";
  const diagnostic = typeof structured.diagnostic === "string" ? structured.diagnostic.replace(/[^A-Za-z0-9 .,()/@:_-]/g, "").slice(0, 260) : "";
  process.stderr.write(`ISSUE37_SANDBOX_FAILURE=${safeCode}${diagnostic ? ` ISSUE37_SANDBOX_DIAGNOSTIC=${diagnostic}` : ""}\n`);
  process.exitCode = 1;
});
