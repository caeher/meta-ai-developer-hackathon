import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { identityFromAuthenticatedSession } from "@meta-game/db";
import { createPrivateSnapshotStorage, type PrivateObjectClient } from "@meta-game/storage";
import type { AgentSandbox } from "../apps/worker/src/agent/tools";
import { createVersionService } from "../apps/worker/src/versions/service";

const projectId = "00000000-0000-4000-8000-000000000111";
const ownerUserId = "00000000-0000-4000-8000-000000000101";
const identity = identityFromAuthenticatedSession({ userId: "user_versionsOwner001" });
const spec = {
  schemaVersion: 1 as const,
  genre: "platformer" as const,
  intent: "create" as const,
  objective: "Juego con versiones verificables",
  changes: [],
  controls: { movement: "arrows" as const, action: "space" as const, touch: true as const },
};

function makeSandbox() {
  const text = new Map<string, string>([
    ["package.json", '{"name":"fixture","version":"1.0.0"}\n'],
    ["package-lock.json", '{"lockfileVersion":3,"packages":{}}\n'],
    ["src/game/project-spec.json", `${JSON.stringify(spec, null, 2)}\n`],
    ["public/assets/manifest.json", '{"schemaVersion":1,"assets":[]}\n'],
    ["public/assets/player.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>\n'],
    ["src/main.ts", "export const level = 1;\n"],
    [".env.local", "META_API_KEY=never snapshot this\n"],
  ]);
  const binary = new Map<string, Uint8Array>([["public/assets/generated/player.png", Uint8Array.from([137, 80, 78, 71, 1, 2, 3])]]);
  let failWrite = false;
  const sandbox = {
    async listFiles(_projectId: string, directory = "") {
      const all = [...text.keys(), ...binary.keys()];
      const children = new Map<string, { name: string; type: "file" | "directory"; size: number }>();
      for (const path of all) {
        if (directory && !path.startsWith(`${directory}/`)) continue;
        const rest = directory ? path.slice(directory.length + 1) : path;
        const [name, ...tail] = rest.split("/");
        if (!name) continue;
        if (tail.length) children.set(name, { name, type: "directory", size: 0 });
        else children.set(name, { name, type: "file", size: text.has(path) ? Buffer.byteLength(text.get(path)!) : binary.get(path)!.byteLength });
      }
      return { path: directory, files: [...children.values()] };
    },
    async readFile(_projectId: string, path: string) {
      const content = text.get(path);
      if (content === undefined) throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return { path, content };
    },
    async readBinaryFile(_projectId: string, path: string) {
      const content = binary.get(path);
      if (!content) throw Object.assign(new Error("missing"), { code: "file_not_found" });
      return Uint8Array.from(content);
    },
    async writeFile(_projectId: string, path: string, content: string) {
      if (failWrite) { failWrite = false; throw new Error("fixture_write_failure"); }
      text.set(path, content); binary.delete(path);
      return { path, bytesWritten: Buffer.byteLength(content) };
    },
    async writeBinaryFile(_projectId: string, path: string, content: Uint8Array) {
      binary.set(path, Uint8Array.from(content)); text.delete(path);
      return { path, bytesWritten: content.byteLength };
    },
    async deleteFile(_projectId: string, path: string) {
      const deleted = text.delete(path) || binary.delete(path);
      return { path, deleted };
    },
    failNextWrite() { failWrite = true; },
    text,
    binary,
  };
  return sandbox as typeof sandbox & AgentSandbox;
}

function makeService(sandbox: ReturnType<typeof makeSandbox>) {
  const objects = new Map<string, Uint8Array>();
  const client: PrivateObjectClient = {
    async put({ key, body, ifAbsent }) {
      if (ifAbsent && objects.has(key)) throw new Error("precondition failed");
      objects.set(key, Uint8Array.from(body));
    },
    async head(key) {
      const body = objects.get(key);
      if (!body) throw Object.assign(new Error("missing"), { name: "NotFound" });
      return { sizeBytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") };
    },
    async get(key) {
      const body = objects.get(key);
      if (!body) throw new Error("missing");
      return Uint8Array.from(body);
    },
    async delete(key) { objects.delete(key); },
  };
  type FakeVersionRow = {
    id: string;
    projectId: string;
    versionNumber: number;
    status: "creating" | "ready" | "failed";
    createdAt: Date;
    snapshotKey: string;
    runId?: string | null;
    parentVersionId?: string | null;
    sha256?: string;
    sizeBytes?: number;
    manifest?: { files: Array<{ path: string; sha256: string }> };
  };
  const rows = new Map<string, FakeVersionRow>();
  let nextNumber = 0;
  let restoreLocked = false;
  let failCreateRestored = false;
  const versions = {
    async ownerId() { return ownerUserId; },
    async latest() { return [...rows.values()].filter((row) => row.status === "ready").sort((a, b) => b.versionNumber - a.versionNumber)[0]; },
    async reserveForRun(_identity: unknown, claim: { runId: string }, input: Omit<FakeVersionRow, "id" | "projectId" | "versionNumber" | "status" | "createdAt" | "snapshotKey">) {
      if (!objects.has(`private/${ownerUserId}/projects/${projectId}/versions/${claim.runId}`)) throw new Error("snapshot_must_exist_before_row");
      const existing = rows.get(claim.runId);
      if (existing) return existing;
      const row: FakeVersionRow = { ...input, id: claim.runId, projectId, versionNumber: ++nextNumber, status: "creating", createdAt: new Date(), snapshotKey: "private-hidden" };
      rows.set(row.id, row);
      return row;
    },
    async markRunSnapshotReady(_identity: unknown, _claim: unknown, id: string) { const row = rows.get(id)!; row.status = "ready"; return row; },
    async markRunSnapshotFailed(_identity: unknown, _claim: unknown, id: string) { const row = rows.get(id)!; row.status = "failed"; return row; },
    async get(_identity: unknown, _projectId: string, id: string) { const row = rows.get(id); return row?.status === "ready" ? row : undefined; },
    async acquireRestoreLock() { if (restoreLocked) throw new Error("ProjectRunBusyError"); restoreLocked = true; return { ownerUserId, projectId, fencingToken: 1, leaseMs: 120_000 }; },
    async renewRestoreLock() { if (!restoreLocked) throw new Error("lock lost"); },
    async releaseRestoreLock() { restoreLocked = false; },
    async create(_identity: unknown, input: { versionId: string; parentVersionId: string | null; manifest: FakeVersionRow["manifest"]; sha256: string; sizeBytes: number }) {
      const row: FakeVersionRow = { ...input, id: input.versionId, projectId, versionNumber: ++nextNumber, status: "creating", createdAt: new Date(), snapshotKey: "private-hidden" };
      rows.set(row.id, row); return row;
    },
    async createRestored(_identity: unknown, _lock: unknown, input: { versionId: string; parentVersionId: string | null; manifest: FakeVersionRow["manifest"]; sha256: string; sizeBytes: number }) {
      if (!objects.has(`private/${ownerUserId}/projects/${projectId}/versions/${input.versionId}`)) throw new Error("snapshot_must_exist_before_row");
      if (failCreateRestored) { failCreateRestored = false; throw new Error("fixture_commit_failure"); }
      const row: FakeVersionRow = { ...input, id: input.versionId, projectId, versionNumber: ++nextNumber, status: "ready", createdAt: new Date(), snapshotKey: "private-hidden" };
      rows.set(row.id, row); return row;
    },
    failNextCreateRestored() { failCreateRestored = true; },
    async setStatus(_identity: unknown, id: string, status: FakeVersionRow["status"]) { const row = rows.get(id)!; row.status = status; return row; },
  };
  const service = createVersionService({
    versions: versions as never,
    storage: createPrivateSnapshotStorage(client),
    sandbox,
  });
  return { service, rows, objects, versions };
}

function claim(runId = randomUUID()) {
  return { runId, ownerUserId, projectId, fencingToken: 7 };
}

describe("snapshots y restauración de versiones", () => {
  it("guarda dos verificaciones privadas y restaura la primera como una tercera versión", async () => {
    const sandbox = makeSandbox();
    const { service, rows } = makeService(sandbox);
    const first = claim();
    await service.captureVerifiedRun({ identity, claim: first, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    const firstText = sandbox.text.get("src/main.ts");
    sandbox.text.set("src/main.ts", "export const level = 2;\n");
    const second = claim();
    await service.captureVerifiedRun({ identity, claim: second, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });

    const restored = await service.restore(identity, projectId, first.runId);
    expect(restored).toMatchObject({ versionNumber: 3 });
    expect(sandbox.text.get("src/main.ts")).toBe(firstText);
    expect(sandbox.binary.get("public/assets/generated/player.png")).toEqual(Uint8Array.from([137, 80, 78, 71, 1, 2, 3]));
    expect(rows.get(restored!.versionId)).toMatchObject({ status: "ready", parentVersionId: first.runId });
    expect([...rows.values()].every((row) => row.manifest?.files.every((file) => file.path !== ".env.local"))).toBe(true);
  });

  it("conserva una versión lista si el mismo run intenta escribir contenido distinto", async () => {
    const sandbox = makeSandbox();
    const { service, rows, objects } = makeService(sandbox);
    const run = claim();
    await service.captureVerifiedRun({ identity, claim: run, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    sandbox.text.set("src/main.ts", "export const level = 99;\n");

    await expect(service.captureVerifiedRun({ identity, claim: run, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal })).rejects.toThrow();
    expect(rows.get(run.runId)?.status).toBe("ready");
    expect(objects.size).toBe(1);
    const prior = await service.read(identity, projectId, run.runId);
    expect(prior?.snapshot.files.find((file) => file.path === "src/main.ts")?.content).toBe("export const level = 1;\n");
  });

  it("recupera el workspace previo si falla una escritura de restauración", async () => {
    const sandbox = makeSandbox();
    const { service, rows } = makeService(sandbox);
    const first = claim();
    await service.captureVerifiedRun({ identity, claim: first, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    sandbox.text.set("src/main.ts", "export const level = 2;\n");
    const second = claim();
    await service.captureVerifiedRun({ identity, claim: second, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    sandbox.failNextWrite();

    await expect(service.restore(identity, projectId, first.runId)).rejects.toThrow("fixture_write_failure");
    expect(sandbox.text.get("src/main.ts")).toBe("export const level = 2;\n");
    expect([...rows.values()].filter((row) => row.status === "ready")).toHaveLength(2);
  });

  it("revierte el workspace y borra el objeto si falla el commit de la versión restaurada", async () => {
    const sandbox = makeSandbox();
    const { service, rows, objects, versions } = makeService(sandbox);
    const first = claim();
    await service.captureVerifiedRun({ identity, claim: first, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    sandbox.text.set("src/main.ts", "export const level = 2;\n");
    const second = claim();
    await service.captureVerifiedRun({ identity, claim: second, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    versions.failNextCreateRestored();

    await expect(service.restore(identity, projectId, first.runId)).rejects.toThrow("fixture_commit_failure");
    expect(sandbox.text.get("src/main.ts")).toBe("export const level = 2;\n");
    expect([...rows.values()].filter((row) => row.status === "ready")).toHaveLength(2);
    expect(objects.size).toBe(2);
  });
});
