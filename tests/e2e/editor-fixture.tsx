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
const projectNameKey = `editor-e2e-name-${projectId}`;
let privateApiInstalled = false;

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

function installPrivateApiFixture() {
  if (privateApiInstalled) return;
  privateApiInstalled = true;
  const browserFetch = window.fetch.bind(window);
  let nextGrant = 0;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

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
          />
        </main>
      </Theme>
    </StrictMode>
  );
}

createRoot(document.getElementById("root")!).render(<EditorTestApp />);
