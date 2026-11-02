import { describe, expect, it } from "vitest";
import type { AgentSandbox } from "../../apps/worker/src/agent/tools";
import {
  inspectPhaserTemplate,
  loadPhaserTemplate,
  materializePhaserTemplate,
  PHASER_TEMPLATE_ID,
  PHASER_TEMPLATE_MARKER_PATH,
} from "../../apps/worker/src/agent/phaser-template";

const missing = Object.assign(new Error("not_found"), { code: "not_found" });

describe("bootstrap de plantilla Phaser", () => {
  it("carga solo archivos allowlisted con versiones y hashes fijados", async () => {
    const template = await loadPhaserTemplate();
    const paths = template.files.map(({ path }) => path);
    const packageJson = JSON.parse(template.files.find(({ path }) => path === "package.json")!.content) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      engines: { node: string };
    };

    expect(template.id).toBe(PHASER_TEMPLATE_ID);
    expect(template.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(paths).toContain("package-lock.json");
    expect(paths).toContain("public/assets/manifest.json");
    expect(paths).not.toContain(".env.local");
    expect(paths.some((path) => path.includes("node_modules") || path.startsWith("dist/"))).toBe(false);
    expect(packageJson).toMatchObject({ dependencies: { phaser: "3.90.0" }, engines: { node: ">=24 <25" } });
    expect(template.dependencies.length).toBe(Object.keys(packageJson.dependencies).length + Object.keys(packageJson.devDependencies).length);
    expect(template.dependencies.every(({ version }) => /^\d+\.\d+\.\d+/.test(version))).toBe(true);
  });

  it("siembra por writeFile, instala sin scripts, verifica y publica preview tras health check", async () => {
    const template = await loadPhaserTemplate();
    const order: string[] = [];
    const written = new Map<string, string>();
    const sandbox = {
      async writeFile(_projectId: string, path: string, content: string) {
        order.push(`write:${path}`);
        written.set(path, content);
        return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
      },
      async installDependencies(_projectId: string, input: { packages: Array<{ name: string; version: string }> }) {
        order.push("install");
        expect(input.packages).toEqual(template.dependencies);
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, truncated: false };
      },
      async runCommand(_projectId: string, input: { args: string[] }) {
        order.push(`run:${input.args.join(" ")}`);
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, truncated: false };
      },
      async startDevServer() {
        order.push("server");
        return { status: "ready", port: 4173, leaseExpiresAt: "2026-11-02T12:00:00.000Z" } as const;
      },
    } as unknown as AgentSandbox;
    const checks: Array<{ check: string; status: string }> = [];

    await materializePhaserTemplate(sandbox, "project-id", template, new AbortController().signal, async (check) => {
      checks.push({ check: check.check, status: check.status });
    });

    expect(order[0]).toBe(`write:${PHASER_TEMPLATE_MARKER_PATH}`);
    expect(order.indexOf("install")).toBeGreaterThan(order.findIndex((entry) => entry.startsWith("write:src/")));
    expect(order.indexOf("run:test")).toBeGreaterThan(order.indexOf("install"));
    expect(order.indexOf("run:run build")).toBeGreaterThan(order.indexOf("run:test"));
    expect(order.indexOf("server")).toBeGreaterThan(order.indexOf("run:run build"));
    expect(order.at(-1)).toBe(`write:${PHASER_TEMPLATE_MARKER_PATH}`);
    expect(JSON.parse(written.get(PHASER_TEMPLATE_MARKER_PATH)!)).toMatchObject({
      templateId: PHASER_TEMPLATE_ID,
      manifestSha256: template.manifestSha256,
      status: "ready",
    });
    expect(checks).toEqual([
      { check: "Phaser dependencies", status: "passed" },
      { check: "Phaser template npm test", status: "passed" },
      { check: "Phaser template npm run build", status: "passed" },
      { check: "Phaser template preview", status: "passed" },
    ]);
  });

  it("preserva workspaces ajenos y reconoce una siembra recuperable", async () => {
    const template = await loadPhaserTemplate();
    const sandbox = {
      async readFile(_projectId: string, path: string) {
        if (path === PHASER_TEMPLATE_MARKER_PATH) throw missing;
        return { path, content: "" };
      },
      async listFiles() { return { path: "", files: [{ name: "README.md", type: "file", size: 1 }] }; },
    } as unknown as AgentSandbox;

    await expect(inspectPhaserTemplate(sandbox, "project-id", template, new AbortController().signal, false))
      .resolves.toEqual({ status: "preserve" });
    await expect(inspectPhaserTemplate(sandbox, "project-id", template, new AbortController().signal, true))
      .resolves.toEqual({ status: "resume" });

    const listingLimit = Object.assign(new Error("directory_read_failed"), { code: "directory_read_failed" });
    const oversizedWorkspace = { ...sandbox, async listFiles() { throw listingLimit; } } as unknown as AgentSandbox;
    await expect(inspectPhaserTemplate(oversizedWorkspace, "project-id", template, new AbortController().signal, false))
      .resolves.toEqual({ status: "preserve" });
  });
});
