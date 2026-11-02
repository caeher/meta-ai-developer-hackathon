"use client";

import { Badge, Card, Flex, Grid, Heading, Text, TextField } from "@radix-ui/themes";
import { Avatar } from "./avatar";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { EmptyState, ErrorState, ProgressState } from "./feedback";
import { ScrollArea } from "./scroll-area";
import { Select } from "./select";
import { Tabs } from "./tabs";
import { TextArea } from "./text-area";
import { Tooltip } from "./tooltip";
import styles from "./DesignSystemGallery.module.css";

const palette = [
  { name: "Azul", color: "blue" },
  { name: "Morado", color: "purple" },
  { name: "Cian", color: "cyan" },
  { name: "Verde", color: "green" },
  { name: "Naranja", color: "orange" },
  { name: "Rojo", color: "red" },
] as const;

export function DesignSystemGallery() {
  return (
    <div className={styles.gallery}>
      <section className={styles.section} aria-labelledby="buttons-title">
        <div className={styles.sectionHeading}>
          <Heading as="h2" id="buttons-title" size="5">Botones y colores</Heading>
          <Text as="p" color="gray">Jerarquía, estados y acentos del sistema.</Text>
        </div>
        <Card className={styles.panel} size="3">
          <Flex wrap="wrap" gap="3" align="center">
            <Button>Acción principal</Button>
            <Button variant="soft">Acción secundaria</Button>
            <Button variant="outline">Alternativa</Button>
            <Button variant="ghost">Enlace de acción</Button>
            <Button disabled>Deshabilitado</Button>
            <Tooltip content="Explica una acción sin añadir ruido permanente">
              <Button variant="surface" aria-label="Ayuda sobre la acción">Ayuda</Button>
            </Tooltip>
          </Flex>
          <Flex wrap="wrap" gap="2" className={styles.badges}>
            {palette.map(({ name, color }) => (
              <Badge key={color} color={color} variant="soft">{name}</Badge>
            ))}
          </Flex>
        </Card>
      </section>

      <section className={styles.section} aria-labelledby="forms-title">
        <div className={styles.sectionHeading}>
          <Heading as="h2" id="forms-title" size="5">Formularios</Heading>
          <Text as="p" color="gray">Etiquetas visibles, errores y controles de teclado.</Text>
        </div>
        <Grid columns={{ initial: "1", sm: "2" }} gap="4">
          <Card className={styles.panel} size="3">
            <label className={styles.label} htmlFor="gallery-project-name">Nombre del proyecto</label>
            <TextField.Root id="gallery-project-name" placeholder="Mi aventura" aria-describedby="project-help" />
            <Text id="project-help" as="p" size="2" color="gray">El nombre aparece en tu lista privada de proyectos.</Text>
            <label className={styles.label} htmlFor="gallery-genre">Género</label>
            <Select.Root defaultValue="platformer">
              <Select.Trigger id="gallery-genre" aria-label="Género del juego" placeholder="Elige un género" />
              <Select.Content>
                <Select.Item value="platformer">Plataformas</Select.Item>
                <Select.Item value="puzzle">Puzzle</Select.Item>
                <Select.Item value="top-down">RPG top-down</Select.Item>
              </Select.Content>
            </Select.Root>
          </Card>
          <Card className={styles.panel} size="3">
            <label className={styles.label} htmlFor="gallery-idea">Descripción de la idea</label>
            <TextArea
              id="gallery-idea"
              aria-describedby="idea-help"
              placeholder="Describe las mecánicas de tu juego"
              rows={4}
            />
            <Text id="idea-help" as="p" size="2" color="gray">El campo admite varias líneas.</Text>
            <label className={styles.label} htmlFor="gallery-invalid">Estado de error</label>
            <TextField.Root id="gallery-invalid" aria-invalid="true" aria-describedby="error-help" value="" readOnly />
            <Text id="error-help" as="p" size="2" color="red">Escribe un nombre para continuar.</Text>
          </Card>
        </Grid>
      </section>

      <section className={styles.section} aria-labelledby="overlays-title">
        <div className={styles.sectionHeading}>
          <Heading as="h2" id="overlays-title" size="5">Diálogos y pestañas</Heading>
          <Text as="p" color="gray">Controles de Radix con navegación por teclado y portales temados.</Text>
        </div>
        <Card className={styles.panel} size="3">
          <Flex wrap="wrap" gap="4" align="center">
            <Dialog.Root>
              <Dialog.Trigger className={styles.dialogTrigger}>
                <Button variant="soft">Abrir diálogo de ejemplo</Button>
              </Dialog.Trigger>
              <Dialog.Content>
                <Dialog.Title>Guardar cambios</Dialog.Title>
                <Dialog.Description>El estado del ejemplo se conserva solo en esta página.</Dialog.Description>
                <Flex gap="3" justify="end" mt="5">
                  <Dialog.Close><Button variant="soft">Cerrar</Button></Dialog.Close>
                </Flex>
              </Dialog.Content>
            </Dialog.Root>
            <Avatar fallback="CN" color="purple" variant="soft" alt="Avatar de Cristina" />
            <Text as="span">Avatar con alternativa textual</Text>
          </Flex>
          <Tabs.Root defaultValue="plan" className={styles.tabs}>
            <Tabs.List aria-label="Paneles de ejemplo">
              <Tabs.Trigger value="plan">Plan</Tabs.Trigger>
              <Tabs.Trigger value="archivos">Archivos</Tabs.Trigger>
              <Tabs.Trigger value="verificación">Verificación</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="plan" className={styles.tabContent}>El plan visible describe los pasos de trabajo.</Tabs.Content>
            <Tabs.Content value="archivos" className={styles.tabContent}>Los cambios de archivos se muestran aquí.</Tabs.Content>
            <Tabs.Content value="verificación" className={styles.tabContent}>El progreso y los errores tienen texto asociado.</Tabs.Content>
          </Tabs.Root>
        </Card>
      </section>

      <section className={styles.section} aria-labelledby="states-title">
        <div className={styles.sectionHeading}>
          <Heading as="h2" id="states-title" size="5">Estados</Heading>
          <Text as="p" color="gray">Mensajes con roles accesibles y progreso legible.</Text>
        </div>
        <Grid columns={{ initial: "1", sm: "3" }} gap="4">
          <EmptyState title="Aún no hay proyectos" description="Crea un proyecto para empezar a diseñar un juego." />
          <ErrorState title="No se pudo cargar" description="Vuelve a intentarlo cuando el servicio esté disponible." action={<Button variant="soft">Reintentar</Button>} />
          <Card className={styles.panel} size="3">
            <ProgressState label="Verificando archivos" value={68} description="Comprobación de estructura y tipos." />
          </Card>
        </Grid>
      </section>

      <section className={styles.section} aria-labelledby="scroll-title">
        <div className={styles.sectionHeading}>
          <Heading as="h2" id="scroll-title" size="5">Área desplazable</Heading>
          <Text as="p" color="gray">Región enfocada y etiquetada para contenido largo.</Text>
        </div>
        <Card className={styles.panel} size="3">
            <ScrollArea className={styles.scrollArea} size="2" tabIndex={0} aria-label="Registro de eventos sintéticos">
            <div className={styles.eventList}>
              <Text weight="medium">Actividad reciente</Text>
              {Array.from({ length: 8 }, (_, index) => (
                <Text as="p" key={index} color="gray">
                  Paso {index + 1}: estado de ejemplo listo para revisar.
                </Text>
              ))}
            </div>
          </ScrollArea>
        </Card>
      </section>
    </div>
  );
}
