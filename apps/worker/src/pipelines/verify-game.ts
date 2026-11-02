import {
  GameBrowserVerificationResultSchema,
  type GameBrowserVerificationResult,
  type GameSpec,
  type SandboxToolCommandResult,
} from "@meta-game/contracts";
import { redactSensitiveText } from "../agent/safety";

export type GameVerificationCheck = Readonly<{
  check: string;
  status: "passed" | "failed";
  exitCode?: number;
  summary: string;
}>;

export type VerifyGameResult = Readonly<{ status: "passed" | "failed"; failures: readonly string[] }>;

export async function verifyGame(input: {
  spec: GameSpec;
  readManifest(): Promise<string>;
  runCommand(args: readonly string[]): Promise<SandboxToolCommandResult>;
  startDevServer(): Promise<{ status: string; port: number | null }>;
  verifyInteraction(): Promise<GameBrowserVerificationResult>;
  readLogs(): Promise<{ stdout: string; stderr: string }>;
  onCheck(check: GameVerificationCheck): Promise<void>;
}): Promise<VerifyGameResult> {
  const failures: string[] = [];
  let scripts: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await input.readManifest());
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) throw new Error("manifest_invalid");
    scripts = parsed.scripts;
  } catch {
    const summary = "package.json no contiene JSON válido ni scripts verificables.";
    await record(input, { check: "package.json", status: "failed", exitCode: 1, summary });
    failures.push(`package.json: ${summary}`);
  }

  for (const check of [
    { name: "npm test", args: ["test"], script: "test" },
    { name: "npm run lint", args: ["run", "lint"], script: "lint" },
    { name: "npm run build", args: ["run", "build"], script: "build" },
  ]) {
    if (typeof scripts[check.script] !== "string" || !(scripts[check.script] as string).trim()) {
      const summary = `El proyecto no declara npm ${check.name === "npm test" ? "test" : `run ${check.script}`} para verificarlo.`;
      await record(input, { check: check.name, status: "failed", exitCode: 1, summary });
      failures.push(`${check.name}: ${summary}`);
      continue;
    }
    try {
      const output = await input.runCommand(check.args);
      const exitCode = output.exitCode;
      const details = redactSensitiveText([output.stdout, output.stderr].filter(Boolean).join("\n")).slice(-800);
      const passed = exitCode === 0 && !output.truncated;
      const summary = passed
        ? `${check.name} terminó correctamente.`
        : details || (output.truncated ? `${check.name} superó el límite de salida.` : `${check.name} terminó con error.`);
      await record(input, { check: check.name, status: passed ? "passed" : "failed", exitCode, summary });
      if (!passed) failures.push(`${check.name}: ${summary}`);
    } catch (error) {
      const summary = `No se pudo ejecutar ${check.name}: ${safeErrorCode(error)}.`;
      await record(input, { check: check.name, status: "failed", exitCode: -1, summary });
      failures.push(`${check.name}: ${summary}`);
    }
  }

  let serverReady = false;
  try {
    const server = await input.startDevServer();
    serverReady = server.status === "ready" && server.port === 4173;
    const summary = serverReady ? "Vite respondió al health check del puerto privado." : "El servidor no quedó listo en el puerto privado esperado.";
    await record(input, { check: "preview health", status: serverReady ? "passed" : "failed", summary });
    if (!serverReady) failures.push(`preview health: ${summary}`);
  } catch (error) {
    const summary = `El health check del servidor falló: ${safeErrorCode(error)}.`;
    await record(input, { check: "preview health", status: "failed", summary });
    failures.push(`preview health: ${summary}`);
  }

  if (serverReady) {
    try {
      const browser = GameBrowserVerificationResultSchema.parse(await input.verifyInteraction());
      for (const check of browser.checks) {
        await record(input, { check: `browser ${check.name}`, status: check.status, summary: check.summary });
        if (check.status === "failed") failures.push(`browser ${check.name}: ${redactSensitiveText(check.summary).slice(0, 400)}`);
      }
      if (browser.status !== "passed") failures.push("El navegador aislado no confirmó una interacción jugable.");
      for (const message of browser.consoleErrors) failures.push(`browser console: ${redactSensitiveText(message).slice(0, 400)}`);
      if (browser.blockedRequests > 0) failures.push(`browser network: ${browser.blockedRequests} solicitudes fuera del origen privado fueron bloqueadas.`);
    } catch (error) {
      const summary = `La prueba aislada de navegador no se completó: ${safeErrorCode(error)}.`;
      await record(input, { check: "browser interaction", status: "failed", summary });
      failures.push(`browser interaction: ${summary}`);
    }
  }

  if (failures.length) {
    try {
      const logs = await input.readLogs();
      const details = redactSensitiveText([logs.stdout, logs.stderr].filter(Boolean).join("\n")).slice(-1_200);
      if (details) failures.push(`sandbox logs (untrusted): ${details}`);
    } catch (error) {
      failures.push(`sandbox logs unavailable: ${safeErrorCode(error)}`);
    }
  }
  return { status: failures.length ? "failed" : "passed", failures };
}

async function record(input: { onCheck(check: GameVerificationCheck): Promise<void> }, check: GameVerificationCheck): Promise<void> {
  await input.onCheck({ ...check, summary: redactSensitiveText(check.summary).slice(0, 900) });
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  const candidate = "code" in error ? (error as Error & { code?: unknown }).code : error.message;
  return typeof candidate === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(candidate) ? candidate : "verification_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
