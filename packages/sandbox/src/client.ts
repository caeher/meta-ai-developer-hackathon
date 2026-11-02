import type { SandboxExecResult } from "./driver";
import type { PublicSandboxState } from "./service";
import { SandboxRuntimeError } from "./driver";

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

  create(projectId: string): Promise<PublicSandboxState> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox`, "POST");
  }

  inspect(projectId: string): Promise<PublicSandboxState> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox`, "GET");
  }

  stop(projectId: string): Promise<PublicSandboxState> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox/stop`, "POST");
  }

  destroy(projectId: string): Promise<PublicSandboxState> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox`, "DELETE");
  }

  exec(projectId: string, argv: readonly string[], cwd = "", timeoutMs?: number): Promise<SandboxExecResult> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}/sandbox/exec`, "POST", { argv, cwd, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), {
        method,
        redirect: "error",
        cache: "no-store",
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(130_000),
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
