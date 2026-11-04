import Link from "next/link";
import { Heading } from "@radix-ui/themes";
import { AuthControls } from "../../components/auth/AuthControls";
import { ProjectsDashboard } from "../../components/projects/ProjectsDashboard";
import { requirePageUser } from "../../server/auth/auth";
import { loadProjects, loadUsage } from "../../server/projects/queries";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const identity = await requirePageUser();
  const [page, usage] = await Promise.all([loadProjects(identity), loadUsage(identity)]);
  const generationEnabled = process.env.RUNS_ENABLED === "true";
  const simulatorEnabled = process.env.RUNS_SIMULATOR_ENABLED === "true";
  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/projects" aria-label="Forja, proyectos"><span className="brand-mark" aria-hidden="true">F</span><span>Forja</span></Link>
        <AuthControls />
      </header>
      <ProjectsDashboard initialPage={page} initialUsage={usage} generationEnabled={generationEnabled} simulatorEnabled={simulatorEnabled} />
      <footer className="footer"><Heading as="h2" size="2">Tus conversaciones quedan en PostgreSQL con ownership verificado.</Heading><span>{simulatorEnabled ? "Simulador local de aceptación: crea un juego de excavación determinista en el sandbox, sin llamadas a Meta ni herramientas externas de assets." : generationEnabled ? "Crea un proyecto y describe el juego que quieres construir." : "Generación, ejecución y preview aún no están habilitadas."}</span></footer>
    </main>
  );
}
