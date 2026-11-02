import Link from "next/link";
import { Heading } from "@radix-ui/themes";
import { AuthControls } from "../../components/auth/AuthControls";
import { ProjectsDashboard } from "../../components/projects/ProjectsDashboard";
import { requireUser } from "../../server/auth/auth";
import { getClerkConfiguration } from "../../server/auth/config";
import { loadProjects } from "../../server/projects/queries";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const identity = await requireUser();
  const [page, configuration] = await Promise.all([loadProjects(identity), Promise.resolve(getClerkConfiguration())]);

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/projects" aria-label="Forja, proyectos">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span>Forja</span>
        </Link>
        <AuthControls configured={configuration.configured} />
      </header>
      <ProjectsDashboard initialPage={page} />
      <footer className="footer">
        <Heading as="h2" size="2">Tus conversaciones quedan en PostgreSQL con ownership verificado.</Heading>
        <span>Generación, ejecución y preview aún no están habilitadas.</span>
      </footer>
    </main>
  );
}
