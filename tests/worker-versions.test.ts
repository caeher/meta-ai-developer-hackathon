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
  let failNextHead = false;
  const client: PrivateObjectClient = {
    async put({ key, body, ifAbsent }) {
      if (ifAbsent && objects.has(key)) throw new Error("precondition failed");
      objects.set(key, Uint8Array.from(body));
    },
    async head(key) {
      if (failNextHead) { failNextHead = false; throw new Error("fixture_storage_unavailable"); }
      const body = objects.get(key);
      if (!body) return {};
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
    ownerUserId: string;
    projectId: string;
    versionNumber: number;
    status: "creating" | "ready" | "failed";
    createdAt: Date;
    snapshotKey: string;
    runId?: string | null;
    parentVersionId?: string | null;
    sha256: string;
    sizeBytes: number;
    manifest?: { files: Array<{ path: string; sha256: string }> };
  };
  const rows = new Map<string, FakeVersionRow>();
  let nextNumber = 0;
  let restoreLocked = false;
  let failCreateRestored = false;
  let failRestoredReady = false;
  const versions = {
    async ownerId() { return ownerUserId; },
    async latest() { return [...rows.values()].filter((row) => row.status === "ready").sort((a, b) => b.versionNumber - a.versionNumber)[0]; },
    async reserveForRun(_identity: unknown, claim: { runId: string }, input: Omit<FakeVersionRow, "id" | "ownerUserId" | "projectId" | "versionNumber" | "status" | "createdAt" | "snapshotKey">) {
      const existing = rows.get(claim.runId);
      if (existing) {
        if (existing.sha256 !== input.sha256 || existing.sizeBytes !== input.sizeBytes) throw new Error("snapshot_reservation_conflict");
        return existing;
      }
      if (objects.has(`private/${ownerUserId}/projects/${projectId}/versions/${claim.runId}`)) throw new Error("snapshot_written_before_reservation");
      const row: FakeVersionRow = { ...input, id: claim.runId, ownerUserId, projectId, versionNumber: ++nextNumber, status: "creating", createdAt: new Date(), snapshotKey: "private-hidden" };
      rows.set(row.id, row);
      return row;
    },
    async markRunSnapshotReady(_identity: unknown, _claim: unknown, id: string) { const row = rows.get(id)!; row.status = "ready"; return row; },
    async markRunSnapshotFailed(_identity: unknown, _claim: unknown, id: string) { const row = rows.get(id)!; row.status = "failed"; return row; },
    async get(_identity: unknown, _projectId: string, id: string) { const row = rows.get(id); return row?.status === "ready" ? row : undefined; },
    async getSnapshotCandidate(_identity: unknown, _projectId: string, id: string) { return rows.get(id); },
    async listSnapshotReconciliationCandidates(cutoff: Date, limit: number) {
      return [...rows.values()].filter((row) => row.status === "creating" && row.createdAt < cutoff).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit);
    },
    async reconcileSnapshotCandidate(input: { id: string; ownerUserId: string; projectId: string; sha256: string; sizeBytes: number; createdAt: Date; cutoff: Date; status: "ready" | "failed" }) {
      const row = rows.get(input.id);
      if (!row || row.ownerUserId !== input.ownerUserId || row.projectId !== input.projectId || row.sha256 !== input.sha256 || row.sizeBytes !== input.sizeBytes || row.createdAt.getTime() !== input.createdAt.getTime() || row.createdAt >= input.cutoff || row.status !== "creating") return false;
      row.status = input.status;
      return true;
    },
    async acquireRestoreLock() { if (restoreLocked) throw new Error("ProjectRunBusyError"); restoreLocked = true; return { ownerUserId, projectId, fencingToken: 1, leaseMs: 120_000 }; },
    async renewRestoreLock() { if (!restoreLocked) throw new Error("lock lost"); },
    async releaseRestoreLock() { restoreLocked = false; },
    async create(_identity: unknown, input: { versionId: string; parentVersionId: string | null; manifest: FakeVersionRow["manifest"]; sha256: string; sizeBytes: number }) {
      const row: FakeVersionRow = { ...input, id: input.versionId, ownerUserId, projectId, versionNumber: ++nextNumber, status: "creating", createdAt: new Date(), snapshotKey: "private-hidden" };
      rows.set(row.id, row); return row;
    },
    async createRestored(_identity: unknown, _lock: unknown, input: { versionId: string; parentVersionId: string | null; manifest: FakeVersionRow["manifest"]; sha256: string; sizeBytes: number }) {
      if (objects.has(`private/${ownerUserId}/projects/${projectId}/versions/${input.versionId}`)) throw new Error("snapshot_written_before_reservation");
      if (failCreateRestored) { failCreateRestored = false; throw new Error("fixture_commit_failure"); }
      const row: FakeVersionRow = { ...input, id: input.versionId, ownerUserId, projectId, versionNumber: ++nextNumber, status: "creating", createdAt: new Date(), snapshotKey: "private-hidden" };
      rows.set(row.id, row); return row;
    },
    async markRestoredSnapshotReady(_identity: unknown, _lock: unknown, id: string) {
      if (failRestoredReady) { failRestoredReady = false; throw new Error("fixture_ready_commit_ambiguous"); }
      const row = rows.get(id)!; row.status = "ready"; return row;
    },
    failNextCreateRestored() { failCreateRestored = true; },
    failNextRestoredReady() { failRestoredReady = true; },
    async setStatus(_identity: unknown, id: string, status: FakeVersionRow["status"]) { const row = rows.get(id)!; row.status = status; return row; },
  };
  const service = createVersionService({
    versions: versions as never,
    storage: createPrivateSnapshotStorage(client),
    sandbox,
  });
  return { service, rows, objects, versions, failNextHead() { failNextHead = true; } };
}

function claim(runId = randomUUID()) {
  return { runId, ownerUserId, projectId, fencingToken: 7 };
}

describe("snapshots y restauración de versiones", () => {
  it("captura la plantilla Phaser sin confundir versiones npm ni coordenadas SVG con teléfonos", async () => {
    const sandbox = makeSandbox();
    sandbox.text.set("package-lock.json", JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/@esbuild/linux-x64": {
          resolved: "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.24.0.tgz",
        },
      },
    }));
    sandbox.text.set("public/assets/player.svg", '<svg viewBox="0 0 64 64"><path d="M 415 555 0147 32 8"/></svg>');
    const { service } = makeService(sandbox);
    const run = claim();

    await service.captureVerifiedRun({ identity, claim: run, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });

    const captured = await service.read(identity, projectId, run.runId);
    expect(captured?.snapshot.files.map((file) => file.path)).toContain("package-lock.json");
    expect(captured?.snapshot.files.map((file) => file.path)).toContain("public/assets/player.svg");
  });

  it("sigue rechazando un teléfono en código del workspace", async () => {
    const sandbox = makeSandbox();
    sandbox.text.set("src/main.ts", "// Contact: 202-555-0147\n");
    const { service } = makeService(sandbox);

    await expect(service.captureVerifiedRun({
      identity,
      claim: claim(),
      gameSpec: spec,
      checks: [{ check: "build", status: "passed", summary: "Build correcto" }],
      signal: new AbortController().signal,
    })).rejects.toThrow("version_sensitive_content_blocked");
  });

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

  it("recupera tras una caída la versión cuyo objeto y reserva quedaron persistidos", async () => {
    const { service, rows } = makeService(makeSandbox());
    const run = claim();
    await service.captureVerifiedRun({ identity, claim: run, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    const pending = rows.get(run.runId)!;
    pending.status = "creating";
    pending.createdAt = new Date(Date.now() - 31 * 60_000);

    await expect(service.reconcilePendingSnapshots()).resolves.toMatchObject({ scanned: 1, recovered: 1, failed: 0, deferred: 0 });
    expect(pending.status).toBe("ready");
  });

  it("marca fallida una reserva antigua si el objeto S3 no existe", async () => {
    const { service, rows, objects } = makeService(makeSandbox());
    const run = claim();
    await service.captureVerifiedRun({ identity, claim: run, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    const pending = rows.get(run.runId)!;
    pending.status = "creating";
    pending.createdAt = new Date(Date.now() - 31 * 60_000);
    objects.delete(`private/${ownerUserId}/projects/${projectId}/versions/${run.runId}`);

    await expect(service.reconcilePendingSnapshots()).resolves.toMatchObject({ scanned: 1, recovered: 0, failed: 1, deferred: 0 });
    expect(pending.status).toBe("failed");
  });

  it("deja pendiente la reserva si S3 falla temporalmente", async () => {
    const { service, rows, failNextHead } = makeService(makeSandbox());
    const run = claim();
    await service.captureVerifiedRun({ identity, claim: run, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    const pending = rows.get(run.runId)!;
    pending.status = "creating";
    pending.createdAt = new Date(Date.now() - 31 * 60_000);
    failNextHead();

    await expect(service.reconcilePendingSnapshots()).resolves.toMatchObject({ scanned: 1, recovered: 0, failed: 0, deferred: 1 });
    expect(pending.status).toBe("creating");
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

  it("resuelve una confirmación SQL ambigua del snapshot restaurado sin descartar el objeto", async () => {
    const sandbox = makeSandbox();
    const { service, rows, objects, versions } = makeService(sandbox);
    const first = claim();
    await service.captureVerifiedRun({ identity, claim: first, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    sandbox.text.set("src/main.ts", "export const level = 2;\n");
    const second = claim();
    await service.captureVerifiedRun({ identity, claim: second, gameSpec: spec, checks: [{ check: "build", status: "passed", summary: "Build correcto" }], signal: new AbortController().signal });
    versions.failNextRestoredReady();

    const restored = await service.restore(identity, projectId, first.runId);
    expect(restored).toMatchObject({ versionNumber: 3 });
    expect(sandbox.text.get("src/main.ts")).toBe("export const level = 1;\n");
    expect(rows.get(restored!.versionId)?.status).toBe("ready");
    expect(objects.size).toBe(3);
  });
});
