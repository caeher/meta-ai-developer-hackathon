import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { EditorShell, type PersistedMessage } from "../../apps/web/components/editor/EditorShell";
import { PreviewHandoff } from "../../apps/web/components/editor/PreviewHandoff";
import { AuthPage } from "../../apps/web/components/auth/AuthPage";
import { AuthControls } from "../../apps/web/components/auth/AuthControls";
import { ProjectsDashboard } from "../../apps/web/components/projects/ProjectsDashboard";
import pageStyles from "../../apps/web/app/projects/[projectId]/page.module.css";
import "@radix-ui/themes/styles.css";
import "../../apps/web/styles/tokens.css";
import "../../apps/web/styles/radix.css";
import "../../apps/web/styles/globals.css";

const projectId = "9fe9e0e0-0b85-4eb8-bd69-7f16c7569f28";
const messageKey = `editor-e2e-messages-${projectId}`;
const runKey = `editor-e2e-run-${projectId}`;
const streamCursorsKey = `editor-e2e-stream-cursors-${projectId}`;
const projectNameKey = `editor-e2e-name-${projectId}`;
const publicationsKey = `editor-e2e-publications-${projectId}`;
const authSessionKey = "forja-e2e-authenticated";
const routeFlagsKey = "forja-e2e-route-flags";
const fixtureUsage = {
  projects: { used: 0, limit: 10 },
  concurrency: { used: 0, limit: 1 },
  tokens: { used: 0, reserved: 0, limit: 100_000 },
  images: { used: 0, reserved: 0, limit: 20 },
  storage: { usedBytes: 0, reservedBytes: 0, limitBytes: 50 * 1024 * 1024 },
  run: { maxTokens: 20_000, maxDurationMs: 600_000 },
};
let privateApiInstalled = false;

interface RunFixture {
  run: {
    id: string;
    projectId: string;
    status: "queued" | "planning" | "running" | "verifying" | "succeeded" | "failed" | "cancelled";
    errorCode: string | null;
    cancelRequested: boolean;
    createdAt: string;
    updatedAt: string;
  };
  idempotencyKey: string;
  sourceMessageRequestId: string;
  owner: string;
  events: Array<Record<string, unknown>>;
  activeFixture: boolean;
}

function readMessages(): PersistedMessage[] {
  try {
    return JSON.parse(sessionStorage.getItem(messageKey) ?? "[]") as PersistedMessage[];
  } catch {
    return [];
  }
}

function readProjectName(): string {
  return sessionStorage.getItem(projectNameKey) ?? "Aventura de prueba";
}

function readPublications() {
  try { return JSON.parse(sessionStorage.getItem(publicationsKey) ?? "[]") as Array<Record<string, unknown>>; }
  catch { return []; }
}

function readRun(): RunFixture | null {
  try { return JSON.parse(sessionStorage.getItem(runKey) ?? "null") as RunFixture | null; }
  catch { return null; }
}

function saveRun(run: RunFixture | null) {
  if (run) sessionStorage.setItem(runKey, JSON.stringify(run));
  else sessionStorage.removeItem(runKey);
}

function fixtureEvent(runId: string, sequence: number, type: string, payload: Record<string, unknown>) {
  return {
    id: sequence,
    type,
    data: {
      version: 1,
      runId,
      sequence,
      createdAt: new Date(Date.now() + sequence).toISOString(),
      type,
      payload,
    },
  };
}

function sse(events: Array<Record<string, unknown>>, after: number) {
  const frames = events.filter((event) => Number(event.id) > after).map((event) =>
    `id: ${String(event.id)}\nevent: ${String(event.type)}\ndata: ${JSON.stringify(event.data)}\n\n`,
  );
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "cache-control": "private, no-store", "content-type": "text/event-stream; charset=utf-8" } });
}

function installPrivateApiFixture() {
  if (privateApiInstalled) return;
  privateApiInstalled = true;
  const browserFetch = window.fetch.bind(window);
  let nextGrant = 0;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const identity = new URLSearchParams(location.search).get("identity") ?? "owner-a";
    const query = new URLSearchParams(location.search);
    const savedFlags = (() => {
      try { return JSON.parse(sessionStorage.getItem(routeFlagsKey) ?? "[]") as string[]; }
      catch { return []; }
    })();

    if (url.pathname === "/api/auth/session" && method === "GET") {
      return Response.json({ user: sessionStorage.getItem(authSessionKey) ? { userId: "e2e-user-a", email: "jugador@example.test" } : null });
    }
    if (url.pathname === "/api/auth/login" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string; password?: string };
      if (query.has("login-error") || !body.email || !body.password) return Response.json({ error: "invalid_credentials" }, { status: 401 });
      sessionStorage.setItem(authSessionKey, "authenticated");
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/auth/logout" && method === "POST") {
      sessionStorage.removeItem(authSessionKey);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/usage" && method === "GET") {
      return Response.json({
        projects: { used: 0, limit: 10 }, concurrency: { used: 0, limit: 1 },
        tokens: { used: 0, reserved: 0, limit: 100_000 }, images: { used: 0, reserved: 0, limit: 20 },
        storage: { usedBytes: 0, reservedBytes: 0, limitBytes: 50 * 1024 * 1024 },
        run: { maxTokens: 20_000, maxDurationMs: 600_000 },
      });
    }
    if (url.pathname === "/api/projects" && method === "GET") return Response.json({ items: [], nextCursor: null });
    if (url.pathname === "/api/projects" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
      sessionStorage.setItem(projectNameKey, body.name?.trim() || "Aventura de prueba");
      return Response.json({ id: projectId, name: sessionStorage.getItem(projectNameKey), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { status: 201 });
    }

    if (url.pathname === `/api/projects/${projectId}/versions` && method === "GET") {
      const items = query.has("versions") || savedFlags.includes("versions") ? [{
        id: "c31d319e-831a-47e0-a1f3-e965c7b7a243", projectId, versionNumber: 3, status: "ready",
      }] : [];
      return Response.json({ items, latestVersionId: items[0]?.id ?? null, nextCursor: null });
    }
    if (url.pathname === `/api/projects/${projectId}/versions/c31d319e-831a-47e0-a1f3-e965c7b7a243` && method === "GET") {
      return Response.json({ version: {
        id: "c31d319e-831a-47e0-a1f3-e965c7b7a243", versionNumber: 3, parentVersionId: null,
        manifest: {
          gameSpec: { genre: "platformer", objective: "Juego fixture" },
          verification: { checks: [{ check: "build", status: "passed", summary: "Build correcto" }] },
          changes: { added: ["src/game.ts"], modified: ["src/main.ts"], removed: [] },
        },
      } });
    }
    if (url.pathname === `/api/projects/${projectId}/versions/c31d319e-831a-47e0-a1f3-e965c7b7a243/restore` && method === "POST") {
      return Response.json({ restored: { versionId: crypto.randomUUID(), versionNumber: 4 } });
    }

    if (url.pathname === `/api/projects/${projectId}/publications` && method === "GET") {
      return Response.json({ items: readPublications(), nextCursor: null });
    }
    if (url.pathname === `/api/projects/${projectId}/publications` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { versionId: string; idempotencyKey: string };
      const existing = readPublications().find((item) => item.idempotencyKey === body.idempotencyKey);
      const publication = existing ?? {
        id: "d31d319e-831a-47e0-a1f3-e965c7b7a243", versionId: body.versionId, versionNumber: 3,
        status: "ready", idempotencyKey: body.idempotencyKey, artifactSha256: "a".repeat(64),
        url: "https://a1b2c3d4e5f607182930.games.example.test", createdAt: new Date().toISOString(),
      };
      const next = [publication, ...readPublications().filter((item) => item.id !== publication.id)];
      sessionStorage.setItem(publicationsKey, JSON.stringify(next));
      return Response.json({ publication }, { status: 200 });
    }
    const publicationRoute = url.pathname.match(new RegExp(`^/api/projects/${projectId}/publications/([0-9a-f-]+)$`, "i"));
    if (publicationRoute && method === "DELETE") {
      const next = readPublications().map((publication) => publication.id === publicationRoute[1] ? { ...publication, status: "revoked", url: null } : publication);
      sessionStorage.setItem(publicationsKey, JSON.stringify(next));
      return Response.json({ revoked: true, id: publicationRoute[1] });
    }

    if (url.pathname === `/api/projects/${projectId}/preview-grant` && method === "POST") {
      nextGrant += 1;
      const deniedIdentity = new URLSearchParams(location.search).get("grant-error");
      if (deniedIdentity === "anonymous") return Response.json({ error: "unauthenticated" }, { status: 401 });
      if (deniedIdentity === "other-owner") return Response.json({ error: "not_found" }, { status: 404 });
      const previewOrigin = `https://${projectId}.preview.example.test`;
      const grant = `header.payload${nextGrant}.signature`;
      const expiresAt = new URLSearchParams(location.search).has("expired-grant")
        ? new Date(Date.now() - 1_000).toISOString()
        : new URLSearchParams(location.search).has("short-session")
        ? new Date(Date.now() + 1_200).toISOString()
        : new Date(Date.now() + 60_000).toISOString();
      return Response.json({ grant, previewUrl: `${previewOrigin}/`, expiresAt });
    }

    if (url.pathname === `/api/projects/${projectId}/messages` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { requestId: string; content: string };
      const existing = readMessages().find((message) => message.requestId === body.requestId);
      if (existing) return Response.json(existing, { status: 201 });
      const saved: PersistedMessage = {
        id: crypto.randomUUID(),
        projectId,
        role: "user",
        content: body.content,
        requestId: body.requestId,
        sequence: readMessages().length + 1,
        createdAt: new Date().toISOString(),
      };
      sessionStorage.setItem(messageKey, JSON.stringify([...readMessages(), saved]));
      return Response.json(saved, { status: 201 });
    }

    if (url.pathname === `/api/projects/${projectId}/runs` && method === "GET") {
      const existing = readRun();
      if (existing && existing.owner !== identity) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({
        run: existing?.run ?? null,
        sourceMessageRequestId: existing?.sourceMessageRequestId ?? null,
        enabled: true,
      });
    }

    if (url.pathname === `/api/projects/${projectId}/runs` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { idempotencyKey: string; messageRequestId: string; contributorConsent?: boolean };
      const existing = readRun();
      if (existing?.idempotencyKey === body.idempotencyKey) return Response.json({ run: existing.run, duplicate: true });
      if (!readMessages().some((message) => message.requestId === body.messageRequestId)) {
        return Response.json({ error: "message_required" }, { status: 400 });
      }
      if (query.has("no-consent")) {
        return Response.json({ error: "contributor_consent_required" }, { status: 403 });
      }
      const enqueueError = query.get("enqueue-error");
      if (enqueueError) return Response.json({ error: enqueueError }, { status: enqueueError.startsWith("usage_limit_") ? 429 : 503 });
      const activeFixture = query.has("run-active");
      const runFailure = query.get("run-fail");
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const run: RunFixture["run"] = {
        id,
        projectId,
        status: activeFixture ? "running" : runFailure ? "failed" : "succeeded",
        errorCode: runFailure,
        cancelRequested: false,
        createdAt,
        updatedAt: createdAt,
      };
      const events: RunFixture["events"] = [
        fixtureEvent(id, 1, "run.queued", { status: "queued" }),
        fixtureEvent(id, 2, "run.status", { status: "planning" }),
        fixtureEvent(id, 3, "plan.created", { summary: "Crear un juego de prueba.", objective: "Moverse hasta la meta.", steps: [{ id: "scene", title: "Crear la escena" }] }),
        fixtureEvent(id, 4, "step.started", { stepId: "write-1", title: "Escribir un archivo" }),
        ...(activeFixture ? [] : runFailure ? [
          fixtureEvent(id, 5, "run.failed", { errorCode: runFailure }),
        ] : [
          fixtureEvent(id, 5, "step.completed", { stepId: "write-1", title: "Escribir un archivo", status: "succeeded" }),
          fixtureEvent(id, 6, "file.changed", { path: "src/main.ts", bytesWritten: 64 }),
          ...(query.has("asset-card") ? [fixtureEvent(id, 7, "asset.card", {
            callId: "asset-card-e2e",
            toolName: "generate_image",
            status: "succeeded",
            title: "Imagen generada",
            summary: "1 frame; PNG y manifiesto guardados.",
            assetType: "sprite",
            assets: [{ assetId: "10000000-0000-4000-8000-000000000236", role: "image", sha256: "a".repeat(64), previewable: true }],
            previewAssetId: "10000000-0000-4000-8000-000000000236",
            frameCount: 1,
            verificationStatus: "needs_review",
            verificationSummary: "Revisión visual pendiente en la preview.",
          })] : []),
          fixtureEvent(id, query.has("asset-card") ? 8 : 7, "verification.result", { check: "npm run build", status: "passed", exitCode: 0, summary: "Build correcto." }),
          fixtureEvent(id, query.has("asset-card") ? 9 : 8, "preview.ready", { state: "ready" }),
          fixtureEvent(id, query.has("asset-card") ? 10 : 9, "run.finished", { summary: "El prototipo quedó verificado." }),
        ]),
      ];
      const record = { run, idempotencyKey: body.idempotencyKey, sourceMessageRequestId: body.messageRequestId, owner: identity, events, activeFixture };
      saveRun(record);
      return Response.json({ run, duplicate: false }, { status: 202 });
    }

    const eventRoute = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/events$/i);
    if (eventRoute) {
      const existing = readRun();
      if (!existing || existing.run.id !== eventRoute[1] || existing.owner !== identity) return Response.json({ error: "not_found" }, { status: 404 });
      const requestHeaders = input instanceof Request ? input.headers : new Headers(init?.headers);
      const cursor = Number(requestHeaders.get("last-event-id") ?? 0);
      const cursors = JSON.parse(sessionStorage.getItem(streamCursorsKey) ?? "[]") as number[];
      cursors.push(Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0);
      sessionStorage.setItem(streamCursorsKey, JSON.stringify(cursors));
      if (new URLSearchParams(location.search).has("stream-drop") && cursors.length === 1) {
        return sse(existing.events.slice(0, 3), Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0);
      }
      return sse(existing.events, Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0);
    }

    const cancelRoute = url.pathname.match(new RegExp(`^/api/projects/${projectId}/runs/([0-9a-f-]+)$`, "i"));
    if (cancelRoute && method === "DELETE") {
      const existing = readRun();
      if (!existing || existing.run.id !== cancelRoute[1] || existing.owner !== identity) return Response.json({ error: "not_found" }, { status: 404 });
      if (existing.activeFixture && existing.run.status !== "cancelled") {
        existing.run = { ...existing.run, status: "cancelled", cancelRequested: false, updatedAt: new Date().toISOString() };
        existing.events = [
          ...existing.events,
          fixtureEvent(existing.run.id, existing.events.length + 1, "run.cancel_requested", {}),
          fixtureEvent(existing.run.id, existing.events.length + 2, "run.cancelled", {}),
        ];
        saveRun(existing);
      }
      return Response.json({ run: existing.run });
    }

    if (url.pathname === `/api/projects/${projectId}` && method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
      sessionStorage.setItem(projectNameKey, body.name);
      return Response.json({ id: projectId, name: body.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }

    if (url.pathname === `/api/projects/${projectId}/messages`) {
      return Response.json({ items: readMessages(), nextCursor: null });
    }

    if (url.origin !== location.origin) return browserFetch(input, init);
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

function EditorTestApp() {
  installPrivateApiFixture();
  const pathname = location.pathname;
  const params = new URLSearchParams(location.search);
  if (pathname === "/sign-in" && params.has("e2e-flow")) {
    sessionStorage.setItem(routeFlagsKey, JSON.stringify(["preview", "versions", "publishing"].filter((flag) => params.has(flag))));
  }
  const savedFlags = (() => {
    try { return JSON.parse(sessionStorage.getItem(routeFlagsKey) ?? "[]") as string[]; }
    catch { return []; }
  })();
  const hasFlag = (flag: string) => params.has(flag) || savedFlags.includes(flag);
  useEffect(() => {
    if ((pathname === "/projects" || pathname.startsWith("/projects/")) && !sessionStorage.getItem(authSessionKey)) {
      window.location.replace("/sign-in");
    }
  }, [pathname]);
  const projectName = readProjectName();
  const previewEnabled = hasFlag("preview");
  const handoffPage = pathname === `/projects/${projectId}/preview/handoff`;
  const versions = hasFlag("versions") ? [{
    id: "c31d319e-831a-47e0-a1f3-e965c7b7a243",
    versionNumber: 3,
    status: "ready" as const,
  }] : [];

  if (handoffPage) {
    return (
      <StrictMode>
        <Theme appearance="dark" accentColor="blue" grayColor="slate" hasBackground={false} panelBackground="solid" radius="medium">
          <PreviewHandoff projectId={projectId} projectName={projectName} baseDomain="preview.example.test" />
        </Theme>
      </StrictMode>
    );
  }

  if (pathname === "/sign-in") {
    return <Theme appearance="dark" accentColor="blue" grayColor="slate" hasBackground={false} panelBackground="solid" radius="medium"><AuthPage mode="login" /></Theme>;
  }

  if (pathname === "/projects") {
    return (
      <Theme appearance="dark" accentColor="blue" grayColor="slate" hasBackground={false} panelBackground="solid" radius="medium">
        <main className="shell">
          <header className="topbar"><a className="brand" href="/projects">Forja</a><AuthControls /></header>
          <ProjectsDashboard initialPage={{ items: [], nextCursor: null }} initialUsage={fixtureUsage} />
        </main>
      </Theme>
    );
  }

  return (
    <StrictMode>
      <Theme appearance="dark" accentColor="blue" grayColor="slate" hasBackground={false} panelBackground="solid" radius="medium">
        <main className={pageStyles.page}>
          <header className={pageStyles.topbar}>
            <div className={pageStyles.brand}>
              <span className={pageStyles.brandMark} aria-hidden="true">F</span>
              <span>Forja</span>
            </div>
            <span>Sesión de prueba</span>
          </header>
          <EditorShell
            projectId={projectId}
            projectName={projectName}
            initialMessages={readMessages()}
            initialCursor={null}
            previewBaseDomain={previewEnabled ? "preview.example.test" : undefined}
            versions={versions}
            publishingEnabled={hasFlag("publishing")}
          />
        </main>
      </Theme>
    </StrictMode>
  );
}

createRoot(document.getElementById("root")!).render(<EditorTestApp />);
