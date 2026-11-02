import Link from "next/link";
import { Badge, Card, Heading, Text } from "@radix-ui/themes";

export default function HomePage() {
  return (
    <main className="shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Forja, inicio">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span>Forja</span>
        </Link>
        <Text as="span" className="status-label">
          <span className="status-dot" aria-hidden="true" />
          Fundaciones
        </Text>
      </header>

      <section className="intro" aria-labelledby="welcome-title">
        <Text as="p" className="eyebrow">Meta AI Developer Hackathon</Text>
        <Heading as="h1" id="welcome-title" size="9" className="intro-title">
          Crea juegos 2D desde una conversación.
        </Heading>
        <Text as="p" className="intro-copy">
          Estamos preparando un espacio para diseñar, construir y probar juegos
          web. Esta primera entrega establece la aplicación y sus contratos
          básicos; la generación y la vista previa aún no están habilitadas.
        </Text>
        <Link className="health-link" href="/api/health">
          Consultar estado del servicio
          <span aria-hidden="true"> ↗</span>
        </Link>
      </section>

      <section className="capabilities" aria-labelledby="capabilities-title">
        <div className="section-heading">
          <div>
            <Text as="p" className="eyebrow">En preparación</Text>
            <Heading as="h2" id="capabilities-title" size="6" className="section-title">
              El taller de juegos
            </Heading>
          </div>
          <span className="phase-count">01 / 28</span>
        </div>
        <div className="capability-grid">
          <article>
            <Card className="capability-card" size="3">
              <Text as="span" className="card-index">01</Text>
              <Heading as="h3" size="4" className="capability-title">Chat creativo</Heading>
              <Text as="p">Describe una idea y recibe un plan visible para construirla.</Text>
              <Badge className="coming-soon" color="gray" variant="outline">Pendiente</Badge>
            </Card>
          </article>
          <article>
            <Card className="capability-card" size="3">
              <Text as="span" className="card-index">02</Text>
              <Heading as="h3" size="4" className="capability-title">Vista previa privada</Heading>
              <Text as="p">Prueba el juego mientras se desarrolla en un entorno aislado.</Text>
              <Badge className="coming-soon" color="gray" variant="outline">Pendiente</Badge>
            </Card>
          </article>
          <article>
            <Card className="capability-card" size="3">
              <Text as="span" className="card-index">03</Text>
              <Heading as="h3" size="4" className="capability-title">Versiones y publicación</Heading>
              <Text as="p">Guarda avances y comparte solo una versión publicada.</Text>
              <Badge className="coming-soon" color="gray" variant="outline">Pendiente</Badge>
            </Card>
          </article>
        </div>
      </section>

      <footer className="footer">
        <Text as="span">Aplicación mínima · Node.js 24</Text>
        <Text as="span">Sin autenticación, generación ni ejecución de juegos todavía</Text>
      </footer>
    </main>
  );
}
