import {
  PUBLICATION_MAX_FILES,
  PUBLICATION_MAX_TOTAL_BYTES,
} from "@meta-game/contracts";
import { identityFromAuthenticatedSession, type VerifiedIdentityContext, type createRepositories } from "@meta-game/db";
import type { SandboxControllerClient } from "@meta-game/sandbox";
import type { createPublicationArtifactStorage } from "@meta-game/storage";

const MAX_WALK_DIRECTORIES = 512;
const BUILD_COMMAND_TIMEOUT_MS = 120_000;
const BUILD_LEASE_MS = 180_000;
const BUILD_WORKSPACE_RECONCILIATION_MS = 20 * 60_000;
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:META_API_KEY|AUTH_SECRET|SESSION_SECRET|DATABASE_URL|REDIS_URL|S3_SECRET_ACCESS_KEY|PUBLISH_S3_SECRET_ACCESS_KEY)\s*[:=]\s*[^\s"'<>]{8,}/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
];

type Repositories = ReturnType<typeof createRepositories>;
type ArtifactStorage = ReturnType<typeof createPublicationArtifactStorage>;
type PublicationSource = {
  version: { id: string; status: string; manifest: Record<string, unknown> };
  snapshot: {
    verification: { status: string; checks: readonly { status: string }[] };
    files: readonly { path: string; encoding: "utf8" | "base64"; content: string; bytes: number }[];
  };
};

export function createPublicationPipeline(input: {
  repositories: Pick<Repositories, "projects" | "publications">;
  versions: { read(identity: VerifiedIdentityContext, projectId: string, versionId: string): Promise<PublicationSource | undefined> };
  sandbox: Pick<SandboxControllerClient, "create" | "destroy" | "writeFile" | "writeBinaryFile" | "runCommand" | "listFiles" | "readFile" | "readBinaryFile">;
  artifacts: ArtifactStorage;
}) {
  const active = new Map<string, Promise<void>>();

  async function start(identity: VerifiedIdentityContext, projectId: string, versionId: string, idempotencyKey: string) {
    const publication = await input.repositories.publications.create(identity, { projectId, versionId, idempotencyKey });
    if (publication.status !== "published" && publication.status !== "revoked") {
      launch(identity, projectId, publication.id);
    }
    return publication;
  }

  function launch(identity: VerifiedIdentityContext, projectId: string, publicationId: string): void {
    if (active.has(publicationId)) return;
    const task = build(identity, projectId, publicationId).catch(() => undefined).finally(() => active.delete(publicationId));
    active.set(publicationId, task);
  }

  async function build(identity: VerifiedIdentityContext, projectId: string, publicationId: string): Promise<void> {
    const lease = await input.repositories.publications.claimBuild(identity, publicationId, BUILD_LEASE_MS);
    if (!lease) return;
    let internalProjectId: string | undefined;
    let sandboxCreateAttempted = false;
    let leaseError: Error | undefined;
    let leaseWorking = false;
    const leaseTimer = setInterval(() => {
      if (leaseWorking) return;
      leaseWorking = true;
      void input.repositories.publications.renewBuildLease(identity, publicationId, lease.buildLeaseToken!, BUILD_LEASE_MS)
        .then((renewed) => { if (!renewed) leaseError = new Error("publication_lease_lost"); })
        .catch(() => { leaseError = new Error("publication_lease_lost"); })
        .finally(() => { leaseWorking = false; });
    }, Math.floor(BUILD_LEASE_MS / 3));
    leaseTimer.unref();
    const assertLease = () => { if (leaseError) throw leaseError; };
    let uploaded = false;
    let committed = false;
    let uploadedSha256: string | undefined;
    try {
      const source = await input.versions.read(identity, projectId, lease.versionId);
      if (!source || source.version.status !== "ready" || source.snapshot.verification.status !== "passed") {
        throw new Error("publication_source_not_verified");
      }
      const snapshotVerification = source.snapshot.verification;
      if (snapshotVerification.checks.some((check) => check.status !== "passed")) throw new Error("publication_source_not_verified");

      const workspace = await input.repositories.projects.createBuildWorkspace(identity);
      internalProjectId = workspace.id;
      sandboxCreateAttempted = true;
      await input.sandbox.create(internalProjectId);
      for (const file of source.snapshot.files) {
        assertLease();
        if (file.encoding === "utf8") await input.sandbox.writeFile(internalProjectId, file.path, file.content);
        else {
          const bytes = Buffer.from(file.content, "base64");
          if (bytes.toString("base64") !== file.content || bytes.byteLength !== file.bytes) throw new Error("publication_snapshot_binary_invalid");
          await input.sandbox.writeBinaryFile(internalProjectId, file.path, bytes);
        }
      }

      const install = await input.sandbox.runCommand(internalProjectId, {
        command: "npm",
        args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=http://npm-proxy:8080/registry/registry.npmjs.org/"],
        timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
      });
      if (install.exitCode !== 0 || install.truncated) throw new Error("publication_dependency_install_failed");
      assertLease();
      const buildResult = await input.sandbox.runCommand(internalProjectId, {
        command: "npm", args: ["run", "build"], timeoutMs: BUILD_COMMAND_TIMEOUT_MS,
      });
      if (buildResult.exitCode !== 0 || buildResult.truncated) throw new Error("publication_build_failed");
      assertLease();

      const files = await readStaticBuild(input.sandbox, internalProjectId, assertLease);
      const publication = await input.repositories.publications.getForCleanup(identity, publicationId);
      if (publication.status !== "building" || publication.buildLeaseToken !== lease.buildLeaseToken) throw new Error("publication_lease_lost");
      const uploadedArtifact = await input.artifacts.write(lease.slug, files);
      uploaded = true;
      uploadedSha256 = uploadedArtifact.artifactSha256;
      assertLease();
      let ready: Awaited<ReturnType<Repositories["publications"]["markPublished"]>>;
      try {
        ready = await input.repositories.publications.markPublished(identity, publicationId, lease.buildLeaseToken!, {
          artifactSha256: uploadedArtifact.artifactSha256,
          manifest: uploadedArtifact.manifest as unknown as Record<string, unknown>,
        });
      } catch {
        const current = await input.repositories.publications.getForCleanup(identity, publicationId).catch(() => undefined);
        if (current?.status === "published" && current.artifactSha256 === uploadedArtifact.artifactSha256) committed = true;
        else throw new Error("publication_commit_ambiguous");
      }
      if (ready) committed = true;
      else if (!committed) {
        const current = await input.repositories.publications.getForCleanup(identity, publicationId).catch(() => undefined);
        committed = current?.status === "published" && current.artifactSha256 === uploadedArtifact.artifactSha256;
        if (!committed) throw new Error("publication_lease_lost");
      }
    } catch {
      const current = await input.repositories.publications.getForCleanup(identity, publicationId).catch(() => undefined);
      committed = committed || (current?.status === "published" && current.artifactSha256 === uploadedSha256);
      if (!committed) {
        if (uploaded || lease) await input.artifacts.delete(lease.slug).catch(() => undefined);
        await input.repositories.publications.markBuildFailed(identity, publicationId, lease.buildLeaseToken!).catch(() => undefined);
      }
    } finally {
      clearInterval(leaseTimer);
      if (internalProjectId && sandboxCreateAttempted) {
        const destroyed = await input.sandbox.destroy(internalProjectId).then(() => true).catch(() => false);
        if (destroyed) await input.repositories.projects.deleteBuildWorkspace(identity, internalProjectId).catch(() => undefined);
      } else if (internalProjectId) {
        await input.repositories.projects.deleteBuildWorkspace(identity, internalProjectId).catch(() => undefined);
      }
    }
  }

  async function revoke(identity: VerifiedIdentityContext, projectId: string, publicationId: string) {
    const publication = await input.repositories.publications.get(identity, projectId, publicationId);
    if (!publication) return undefined;
    const revoked = publication.status === "revoked"
      ? publication
      : await input.repositories.publications.setStatus(identity, publicationId, "revoked");
    await input.artifacts.delete(revoked.slug);
    return revoked;
  }

  async function reconcileExpiredBuilds(options: { now?: number; limit?: number } = {}) {
    const now = options.now ?? Date.now();
    const limit = options.limit ?? 50;
    const rows = await input.repositories.publications.listExpiredBuilds(new Date(now), limit);
    let started = 0;
    for (const { publication, userId } of rows) {
      const identity = identityFromAuthenticatedSession({ userId });
      launch(identity, publication.projectId, publication.id);
      started += 1;
    }
    const cleaned = await input.repositories.projects.reapBuildWorkspaces(new Date(now - BUILD_WORKSPACE_RECONCILIATION_MS), limit);
    return { scanned: rows.length, started, cleaned: cleaned.deleted };
  }

  async function close(): Promise<void> { await Promise.allSettled(active.values()); }

  return { start, revoke, reconcileExpiredBuilds, close };
}

async function readStaticBuild(
  sandbox: Pick<SandboxControllerClient, "listFiles" | "readFile" | "readBinaryFile">,
  projectId: string,
  assertLease: () => void,
) {
  const paths: string[] = [];
  let directoryCount = 0;
  async function walk(relative: string): Promise<void> {
    assertLease();
    if (++directoryCount > MAX_WALK_DIRECTORIES) throw new Error("publication_directory_limit");
    const listing = await sandbox.listFiles(projectId, relative ? `dist/${relative}` : "dist");
    if (listing.files.length > 32) throw new Error("publication_directory_limit");
    for (const entry of listing.files) {
      if (entry.name.startsWith(".") || entry.name.includes("\\") || entry.name === "..") throw new Error("publication_hidden_file_blocked");
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.type === "directory") await walk(path);
      else {
        if (paths.length >= PUBLICATION_MAX_FILES) throw new Error("publication_file_limit");
        paths.push(path);
      }
    }
  }
  await walk("");

  const files: Array<{ path: string; contentType: string; body: Uint8Array }> = [];
  let totalBytes = 0;
  for (const path of paths.sort()) {
    assertLease();
    const contentType = contentTypeForPath(path);
    if (path.toLowerCase().endsWith(".map")) throw new Error("publication_source_map_blocked");
    const fullPath = `dist/${path}`;
    const body = isTextContentType(contentType)
      ? Buffer.from((await sandbox.readFile(projectId, fullPath)).content, "utf8")
      : await sandbox.readBinaryFile(projectId, fullPath);
    if (body.byteLength < 1 || body.byteLength > 8 * 1024 * 1024) throw new Error("publication_file_size_limit");
    totalBytes += body.byteLength;
    if (totalBytes > PUBLICATION_MAX_TOTAL_BYTES) throw new Error("publication_total_size_limit");
    if (hasSecretContent(body)) throw new Error("publication_secret_scan_failed");
    if (isTextContentType(contentType)) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      if (/sourceMappingURL\s*=|<\s*sourceMappingURL/i.test(text)) throw new Error("publication_source_map_reference_blocked");
      if (path === "index.html" && !/<html\b/i.test(text)) throw new Error("publication_index_invalid");
    }
    files.push({ path, contentType, body });
  }
  if (!files.some((file) => file.path === "index.html")) throw new Error("publication_index_missing");
  return files;
}

export function contentTypeForPath(path: string): string {
  if (!/^[A-Za-z0-9._/-]{1,512}$/.test(path) || path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new Error("publication_path_invalid");
  }
  const extension = path.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon", mp3: "audio/mpeg", ogg: "audio/ogg",
    wav: "audio/wav", webm: "audio/webm", mp4: "video/mp4", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
    otf: "font/otf", wasm: "application/wasm",
  };
  const contentType = extension ? types[extension] : undefined;
  if (!contentType || /\.map$/i.test(path) || /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|secrets?[^/]*|credentials?[^/]*)$/i.test(path)) {
    throw new Error("publication_file_type_blocked");
  }
  return contentType;
}

export function hasSecretContent(body: Uint8Array): boolean {
  const content = Buffer.from(body).toString("latin1");
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(content));
}

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json; charset=utf-8";
}
