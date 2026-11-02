import Link from "next/link";
import { Heading } from "@radix-ui/themes";
import { AuthControls } from "../../components/auth/AuthControls";
import { ProjectsDashboard } from "../../components/projects/ProjectsDashboard";
import { requirePageUser } from "../../server/auth/auth";
import { loadProjects } from "../../server/projects/queries";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const identity = await requirePageUser();
  const page = await loadProjects(identity);
  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/projects" aria-label="Forja, proyectos"><span className="brand-mark" aria-hidden="true">F</span><span>Forja</span></Link>
        <AuthControls />
      </header>
      <ProjectsDashboard initialPage={page} />
      <footer className="footer"><Heading as="h2" size="2">Tus conversaciones quedan en PostgreSQL con ownership verificado.</Heading><span>Generación, ejecución y preview aún no están habilitadas.</span></footer>
    </main>
  );
}
