import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { EditorShell, type PersistedMessage } from "../../apps/web/components/editor/EditorShell";
import { PreviewHandoff } from "../../apps/web/components/editor/PreviewHandoff";
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
  const body = events.filter((event) => Number(event.id) > after).map((event) =>
    `id: ${String(event.id)}\nevent: ${String(event.type)}\ndata: ${JSON.stringify(event.data)}\n\n`,
  ).join("");
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

    if (url.pathname === `/api/projects/${projectId}/versions` && method === "GET") {
      const items = new URLSearchParams(location.search).has("versions") ? [{
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
      const body = JSON.parse(String(init?.body ?? "{}")) as { idempotencyKey: string; messageRequestId: string; contributorConsent: boolean };
      const existing = readRun();
      if (existing?.idempotencyKey === body.idempotencyKey) return Response.json({ run: existing.run, duplicate: true });
      if (body.contributorConsent !== true || !readMessages().some((message) => message.requestId === body.messageRequestId)) {
        return Response.json({ error: "contributor_consent_required" }, { status: 400 });
      }
      const activeFixture = new URLSearchParams(location.search).has("run-active");
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const run: RunFixture["run"] = {
        id,
        projectId,
        status: activeFixture ? "running" : "succeeded",
        errorCode: null,
        cancelRequested: false,
        createdAt,
        updatedAt: createdAt,
      };
      const events: RunFixture["events"] = [
        fixtureEvent(id, 1, "run.queued", { status: "queued" }),
        fixtureEvent(id, 2, "run.status", { status: "planning" }),
        fixtureEvent(id, 3, "plan.created", { summary: "Crear un juego de prueba.", objective: "Moverse hasta la meta.", steps: [{ id: "scene", title: "Crear la escena" }] }),
        fixtureEvent(id, 4, "step.started", { stepId: "write-1", title: "Escribir un archivo" }),
        ...(activeFixture ? [] : [
          fixtureEvent(id, 5, "step.completed", { stepId: "write-1", title: "Escribir un archivo", status: "succeeded" }),
          fixtureEvent(id, 6, "file.changed", { path: "src/main.ts", bytesWritten: 64 }),
          fixtureEvent(id, 7, "verification.result", { check: "npm run build", status: "passed", exitCode: 0, summary: "Build correcto." }),
          fixtureEvent(id, 8, "preview.ready", { state: "ready" }),
          fixtureEvent(id, 9, "run.finished", { summary: "El prototipo quedó verificado." }),
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
  const projectName = readProjectName();
  const params = new URLSearchParams(location.search);
  const previewEnabled = params.has("preview");
  const handoffPage = location.pathname === `/projects/${projectId}/preview/handoff`;
  const versions = params.has("versions") ? [{
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
            publishingEnabled={params.has("publishing")}
          />
        </main>
      </Theme>
    </StrictMode>
  );
}

createRoot(document.getElementById("root")!).render(<EditorTestApp />);
