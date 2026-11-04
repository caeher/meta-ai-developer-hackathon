import { describe, expect, it, vi } from "vitest";
import { createPreviewPreparationService } from "../apps/worker/src/preview/prepare";
import { createPreviewGrantHandlers } from "../apps/web/server/preview/handlers";
import { loadPreviewKeyRing } from "@meta-game/preview";
import { generateKeyPairSync } from "node:crypto";

const projectId = "00000000-0000-4000-8000-000000000111";
const identity = { userId: "user_testOwner001" } as never;

function fakeSandbox(files = new Map<string, string>()) {
  const calls: string[] = [];
  const notFound = () => Object.assign(new Error("file_not_found"), { code: "file_not_found" });
  return {
    calls,
    async create() { calls.push("create"); return { sandboxId: "sb", state: "ready", leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), devServer: { status: "stopped", port: null, leaseExpiresAt: null } }; },
    async inspect() { return { sandboxId: "sb", state: "ready", leaseExpiresAt: null, devServer: calls.includes("startDevServer") ? { status: "ready", port: 4173, leaseExpiresAt: null } : { status: "stopped", port: null, leaseExpiresAt: null } }; },
    async readFile(_p: string, path: string) { calls.push(`read:${path}`); const c = files.get(path); if (c === undefined) throw notFound(); return { path, content: c }; },
    async readBinaryFile() { throw notFound(); },
    async writeFile(_p: string, path: string, content: string) { calls.push(`write:${path}`); files.set(path, content); return { path, bytesWritten: Buffer.byteLength(content) }; },
    async writeBinaryFile() { return { path: "", bytesWritten: 0 }; },
    async deleteFile() { return { path: "", deleted: true }; },
    async listFiles() { calls.push("list"); return { path: "", files: [...files.keys()].map((name) => ({ name, type: "file" as const, size: 1 })) }; },
    async installDependencies() { calls.push("install"); return { exitCode: 0, stdout: "", stderr: "" }; },
    async runCommand() { calls.push("run"); return { exitCode: 0, stdout: "", stderr: "" }; },
    async startDevServer() { calls.push("startDevServer"); return { status: "ready", port: 4173, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }; },
    async readLogs() { return { status: "ready", port: 4173, leaseExpiresAt: null, stdout: "", stderr: "" }; },
    async verifyGameInteraction() { throw new Error("unused"); },
  };
}

const template = {
  id: "test-template",
  manifestSha256: "a".repeat(64),
  files: [{ path: "package.json", content: "{}", sha256: "b".repeat(64) }],
  dependencies: [{ name: "phaser", version: "3.90.0" }],
} as never;

describe("preparacion de preview bajo demanda", () => {
  it("crea sandbox, materializa plantilla vacia e inicia dev server", async () => {
    const sandbox = fakeSandbox();
    const service = createPreviewPreparationService({
      projects: { get: async () => ({ id: projectId }) },
      sandbox: sandbox as never,
      loadTemplate: async () => template,
    });
    const result = await service.prepare(identity, projectId);
    expect(result?.devServer.status).toBe("ready");
    expect(sandbox.calls).toContain("create");
    expect(sandbox.calls).toContain("install");
    expect(sandbox.calls).toContain("startDevServer");
  });

  it("devuelve undefined para proyecto ajeno y no crea sandbox", async () => {
    const sandbox = fakeSandbox();
    const service = createPreviewPreparationService({
      projects: { get: async () => undefined },
      sandbox: sandbox as never,
      loadTemplate: async () => template,
    });
    expect(await service.prepare(identity, projectId)).toBeUndefined();
    expect(sandbox.calls).not.toContain("create");
  });

  it("con workspace existente no reescribe plantilla, solo inicia dev server", async () => {
    const sandbox = fakeSandbox(new Map([["src/main.ts", "custom"]]));
    const service = createPreviewPreparationService({
      projects: { get: async () => ({ id: projectId }) },
      sandbox: sandbox as never,
      loadTemplate: async () => template,
    });
    await service.prepare(identity, projectId);
    expect(sandbox.calls).not.toContain("install");
    expect(sandbox.calls).toContain("startDevServer");
  });
});

describe("grant de preview con preparacion", () => {
  it("prepara el sandbox cuando aun no hay target y luego emite el grant", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyRing = loadPreviewKeyRing("k1", privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      JSON.stringify({ k1: publicKey.export({ type: "spki", format: "der" }).toString("base64") }))!;
    let target: { ownerUserId: string; sandboxId: string; projectId: string } | undefined;
    const ownerId = "user_testOwner001";
    const preparePreview = vi.fn(async () => { target = { ownerUserId: ownerId, sandboxId: "00000000-0000-4000-8000-000000000301", projectId }; });
    const handlers = createPreviewGrantHandlers({
      authenticator: { requireUser: async () => identity },
      projects: { get: async () => ({ id: projectId }) },
      target: async () => target,
      preparePreview,
      store: { allowRateLimit: async () => true, getProjectEpoch: async () => 0, revokeProject: async () => undefined } as never,
      keyRing,
      allowedOrigins: ["http://127.0.0.1:3000"],
      baseDomain: "preview.localhost",
      protocol: "http:",
    });
    const response = await handlers.POST(new Request("http://127.0.0.1:3000/api", { method: "POST", headers: { origin: "http://127.0.0.1:3000" } }), { params: Promise.resolve({ projectId }) });
    expect(preparePreview).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect((await response.json()).previewUrl).toBe(`http://${projectId}.preview.localhost/`);
  });
});
