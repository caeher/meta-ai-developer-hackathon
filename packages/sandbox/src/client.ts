import type { PublicSandboxState } from "./service";
import { SandboxRuntimeError } from "./driver";
import {
  SandboxWriteBinaryFileInputSchema,
  type GameBrowserVerificationInput,
  type GameBrowserVerificationResult,
  type SandboxDevServerLogs,
  type SandboxDevServerState,
  type SandboxFileEntry,
  type SandboxInstallDependenciesInput,
  type SandboxRunCommandInput,
  type SandboxToolCommandResult,
} from "@meta-game/contracts";

export class SandboxControllerClient {
  private readonly baseUrl: URL;

  constructor(url: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    this.baseUrl = new URL(url);
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(this.baseUrl.hostname);
    if (!(["http:", "https:"].includes(this.baseUrl.protocol) && (this.baseUrl.protocol === "https:" || loopback)) ||
      this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash || this.baseUrl.pathname !== "/") {
      throw new TypeError("SANDBOX_CONTROLLER_URL must use HTTPS, or HTTP on loopback");
    }
    if (token.length < 32 || /placeholder|replace-me|change-me/i.test(token)) throw new TypeError("Invalid sandbox controller token");
  }

  create(projectId: string, signal?: AbortSignal): Promise<PublicSandboxState> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox`, "POST", undefined, signal);
  }

  inspect(projectId: string, signal?: AbortSignal): Promise<PublicSandboxState> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox`, "GET", undefined, signal);
  }

  stop(projectId: string, signal?: AbortSignal): Promise<PublicSandboxState> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox/stop`, "POST", undefined, signal);
  }

  destroy(projectId: string, signal?: AbortSignal): Promise<PublicSandboxState> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox`, "DELETE", undefined, signal);
  }

  exec(projectId: string, argv: readonly string[], cwd = "", timeoutMs?: number, signal?: AbortSignal): Promise<SandboxToolCommandResult> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox/exec`, "POST", { argv, cwd, ...(timeoutMs ? { timeoutMs } : {}) }, signal);
  }

  readFile(projectId: string, path: string, signal?: AbortSignal): Promise<{ path: string; content: string }> {
    return this.tool(projectId, "read-file", { path }, signal);
  }

  writeFile(projectId: string, path: string, content: string, signal?: AbortSignal): Promise<{ path: string; bytesWritten: number }> {
    return this.tool(projectId, "write-file", { path, content }, signal);
  }

  writeBinaryFile(projectId: string, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<{ path: string; bytesWritten: number }> {
    if (!(bytes instanceof Uint8Array)) throw new SandboxRuntimeError("invalid_tool_input");
    const contentBase64 = Buffer.from(bytes).toString("base64");
    const parsed = SandboxWriteBinaryFileInputSchema.safeParse({ path, contentBase64 });
    if (!parsed.success) throw new SandboxRuntimeError("invalid_tool_input");
    return this.tool(projectId, "write-binary-file", parsed.data, signal);
  }

  listFiles(projectId: string, path = "", signal?: AbortSignal): Promise<{ path: string; files: SandboxFileEntry[] }> {
    return this.tool(projectId, "list-files", { path }, signal);
  }

  installDependencies(projectId: string, input: SandboxInstallDependenciesInput, signal?: AbortSignal): Promise<SandboxToolCommandResult> {
    return this.tool(projectId, "install-dependencies", input, signal);
  }

  runCommand(projectId: string, input: SandboxRunCommandInput, signal?: AbortSignal): Promise<SandboxToolCommandResult> {
    return this.tool(projectId, "run-command", input, signal);
  }

  startDevServer(projectId: string, signal?: AbortSignal): Promise<SandboxDevServerState> {
    return this.tool(projectId, "start-dev-server", {}, signal);
  }

  readLogs(projectId: string, signal?: AbortSignal): Promise<SandboxDevServerLogs> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox/tools/read-logs`, "GET", undefined, signal);
  }

  verifyGameInteraction(projectId: string, input: GameBrowserVerificationInput, signal?: AbortSignal): Promise<GameBrowserVerificationResult> {
    return this.tool(projectId, "verify-game", input, signal);
  }

  private tool<T>(projectId: string, name: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox/tools/${name}`, "POST", body, signal);
  }

  private async request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        method,
        redirect: "error",
        cache: "no-store",
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(130_000)]) : AbortSignal.timeout(130_000),
      });
    } catch {
      throw new SandboxRuntimeError("sandbox_controller_unavailable");
    }
    if (!response.ok) {
      let code = "sandbox_controller_failed";
      try {
        const payload = await response.json() as { error?: unknown };
        if (typeof payload.error === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(payload.error)) code = payload.error;
      } catch { /* Ignore untrusted controller error bodies. */ }
      throw new SandboxRuntimeError(code);
    }
    return await response.json() as T;
  }
}
