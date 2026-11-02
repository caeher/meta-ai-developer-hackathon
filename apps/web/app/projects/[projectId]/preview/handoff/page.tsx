import { notFound } from "next/navigation";
import { PreviewHandoff } from "../../../../../components/editor/PreviewHandoff";
import { requireUser } from "../../../../../server/auth/auth";
import { getPreviewClientConfiguration } from "../../../../../server/preview";
import { loadProjectConversation } from "../../../../../server/projects/queries";

export const dynamic = "force-dynamic";

export default async function PreviewHandoffPage({ params }: { params: Promise<{ projectId: string }> }) {
  const identity = await requireUser();
  const { projectId } = await params;
  const conversation = await loadProjectConversation(identity, projectId);
  if (!conversation) notFound();
  const previewConfiguration = getPreviewClientConfiguration();

  return (
    <PreviewHandoff
      projectId={conversation.project.id}
      projectName={conversation.project.name}
      baseDomain={previewConfiguration.baseDomain}
    />
  );
}
