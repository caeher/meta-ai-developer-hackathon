import { notFound } from "next/navigation";
import Link from "next/link";
import { Heading, Text } from "@radix-ui/themes";
import { DesignSystemGallery } from "../../components/ui/DesignSystemGallery";

export const dynamic = "force-dynamic";

export default function DesignSystemPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Forja, inicio">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span>Forja</span>
        </Link>
        <Text as="span" color="gray">Galería local · Tokyo Night</Text>
      </header>
      <section className="intro" aria-labelledby="design-system-title">
        <Text as="p" className="eyebrow">Sistema visual</Text>
        <Heading as="h1" id="design-system-title" size="8" className="intro-title">
          Componentes del taller
        </Heading>
        <Text as="p" className="intro-copy">
          Controles y estados reutilizables para las vistas de Forja. La galería solo está disponible en desarrollo
          y utiliza contenido sintético.
        </Text>
      </section>
      <DesignSystemGallery />
    </main>
  );
}
