import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { EditorShell, type PersistedMessage } from "../../apps/web/components/editor/EditorShell";
import pageStyles from "../../apps/web/app/projects/[projectId]/page.module.css";
import "@radix-ui/themes/styles.css";
import "../../apps/web/styles/tokens.css";
import "../../apps/web/styles/radix.css";
import "../../apps/web/styles/globals.css";

const projectId = "9fe9e0e0-0b85-4eb8-bd69-7f16c7569f28";
const messageKey = `editor-e2e-messages-${projectId}`;
const projectNameKey = `editor-e2e-name-${projectId}`;

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
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
    const method = init?.method ?? "GET";

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

    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

function EditorTestApp() {
  installPrivateApiFixture();
  const projectName = readProjectName();

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
          <EditorShell projectId={projectId} projectName={projectName} initialMessages={readMessages()} initialCursor={null} />
        </main>
      </Theme>
    </StrictMode>
  );
}

createRoot(document.getElementById("root")!).render(<EditorTestApp />);
