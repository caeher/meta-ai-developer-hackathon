import Link from "next/link";
import { notFound } from "next/navigation";
import { AuthControls } from "../../../components/auth/AuthControls";
import { ProjectConversation } from "../../../components/projects/ProjectConversation";
import { requireUser } from "../../../server/auth/auth";
import { getClerkConfiguration } from "../../../server/auth/config";
import { loadProjectConversation } from "../../../server/projects/queries";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const identity = await requireUser();
  const { projectId } = await params;
  const conversation = await loadProjectConversation(identity, projectId);
  if (!conversation) notFound();
  const configuration = getClerkConfiguration();

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/projects" aria-label="Forja, proyectos">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span>Forja</span>
        </Link>
        <AuthControls configured={configuration.configured} />
      </header>
      <ProjectConversation
        projectId={conversation.project.id}
        projectName={conversation.project.name}
        initialMessages={conversation.transcript.items}
        initialCursor={conversation.transcript.nextCursor}
      />
    </main>
  );
}
