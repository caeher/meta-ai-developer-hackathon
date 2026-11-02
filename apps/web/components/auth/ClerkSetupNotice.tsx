import { Badge, Card, Heading, Text } from "@radix-ui/themes";

export function ClerkSetupNotice() {
  return (
    <Card className="capability-card" size="3">
      <Badge color="orange" variant="soft">Configuración requerida</Badge>
      <Heading as="h1" size="6" className="capability-title">Clerk todavía no está conectado</Heading>
      <Text as="p">
        Para proteger la sesión y los proyectos, configura las claves Clerk del operador en el entorno local.
        Las rutas privadas permanecen cerradas hasta entonces.
      </Text>
    </Card>
  );
}
