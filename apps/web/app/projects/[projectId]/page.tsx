import Link from "next/link";
import { notFound } from "next/navigation";
import { EditorShell } from "../../../components/editor/EditorShell";
import { AuthControls } from "../../../components/auth/AuthControls";
import { requirePageUser } from "../../../server/auth/auth";
import { getPreviewClientConfiguration } from "../../../server/preview";
import { loadProjectConversation } from "../../../server/projects/queries";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const identity = await requirePageUser();
  const { projectId } = await params;
  const conversation = await loadProjectConversation(identity, projectId);
  if (!conversation) notFound();
  const previewConfiguration = getPreviewClientConfiguration();
  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/projects" aria-label="Forja, proyectos"><span className={styles.brandMark} aria-hidden="true">F</span><span>Forja</span></Link>
        <AuthControls />
      </header>
      <EditorShell projectId={conversation.project.id} projectName={conversation.project.name} initialMessages={conversation.transcript.items} initialCursor={conversation.transcript.nextCursor} previewBaseDomain={previewConfiguration.baseDomain} previewProtocol={previewConfiguration.protocol} versions={conversation.versions} publishingEnabled={process.env.PUBLISHING_ENABLED === "true"} simulatorEnabled={process.env.RUNS_SIMULATOR_ENABLED === "true"} />
    </main>
  );
}
