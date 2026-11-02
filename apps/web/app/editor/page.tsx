import { Badge, Card, Heading, Text } from "@radix-ui/themes";
import Link from "next/link";
import { AuthControls } from "../../components/auth/AuthControls";
import { requireUser } from "../../server/auth/auth";
import { getClerkConfiguration } from "../../server/auth/config";

export const dynamic = "force-dynamic";

export default async function EditorPage() {
  await requireUser();
  const configuration = getClerkConfiguration();

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Forja, inicio">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span>Forja</span>
        </Link>
        <AuthControls configured={configuration.configured} />
      </header>
      <section className="intro" aria-labelledby="editor-title">
        <Badge color="green" variant="soft">Sesión verificada</Badge>
        <Heading as="h1" id="editor-title" size="8" className="intro-title">Tu espacio de proyectos</Heading>
        <Text as="p" className="intro-copy">
          La sesión está asociada a una identidad verificada por Clerk. La creación de proyectos llegará en la siguiente entrega.
        </Text>
        <Card className="capability-card" size="3">
          <Text as="p">Estado de sesión: autenticada</Text>
          <Text as="p" color="gray">La identidad interna se conserva y se verifica solo en el servidor.</Text>
        </Card>
      </section>
    </main>
  );
}
