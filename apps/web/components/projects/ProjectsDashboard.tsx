"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge, Button, Card, Dialog, Flex, Heading, Text, TextField } from "@radix-ui/themes";
import styles from "./ProjectsDashboard.module.css";

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface ProjectPage {
  items: ProjectSummary[];
  nextCursor: string | null;
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (body.error === "authentication_not_configured") return "La autenticación no está configurada.";
  if (body.error === "not_found") return "El proyecto ya no está disponible.";
  return "No se pudo completar la solicitud. Inténtalo de nuevo.";
}

export function ProjectsDashboard({ initialPage }: { initialPage: ProjectPage }) {
  const [projects, setProjects] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState("");

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setStatus("");
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const project = await response.json() as ProjectSummary;
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      setName("");
      setStatus("Proyecto creado. Ya puedes abrir su conversación.");
      window.location.assign(`/projects/${project.id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo crear el proyecto.");
    } finally {
      setCreating(false);
    }
  }

  async function renameProject(event: FormEvent<HTMLFormElement>, project: ProjectSummary) {
    event.preventDefault();
    setBusyId(project.id);
    setStatus("");
    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: editName }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const updated = await response.json() as ProjectSummary;
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingId(null);
      setStatus("Nombre del proyecto actualizado.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo renombrar el proyecto.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProject() {
    if (!pendingDelete) return;
    const project = pendingDelete;
    setBusyId(project.id);
    setStatus("");
    try {
      const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      setProjects((current) => current.filter((item) => item.id !== project.id));
      setPendingDelete(null);
      setStatus("Proyecto eliminado. La limpieza privada quedó en cola.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo eliminar el proyecto.");
    } finally {
      setBusyId(null);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "50", cursor: nextCursor });
      const response = await fetch(`/api/projects?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const page = await response.json() as ProjectPage;
      setProjects((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudieron cargar más proyectos.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className={styles.dashboard} aria-labelledby="projects-title">
      <div className={styles.heading}>
        <div>
          <Text as="p" className={styles.eyebrow}>Espacio privado</Text>
          <Heading as="h1" id="projects-title" size="8">Tus proyectos</Heading>
          <Text as="p" color="gray">Cada proyecto y conversación solo está disponible para su propietario.</Text>
        </div>
        <Badge color="cyan" variant="soft">Generación deshabilitada</Badge>
      </div>

      <Card className={styles.createCard} size="3">
        <form className={styles.createForm} onSubmit={createProject}>
          <div className={styles.field}>
            <label htmlFor="new-project-name">Nombre del proyecto</label>
            <TextField.Root
              id="new-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Mi aventura 2D"
              maxLength={120}
              required
              autoComplete="off"
            />
          </div>
          <Button type="submit" disabled={creating || !name.trim()}>
            {creating ? "Creando…" : "Crear proyecto"}
          </Button>
        </form>
      </Card>

      <div className={styles.listHeading}>
        <Heading as="h2" size="5">Proyectos guardados</Heading>
        <Text as="span" color="gray">{projects.length}{nextCursor ? "+" : ""}</Text>
      </div>

      {projects.length === 0 ? (
        <Card className={styles.empty} size="3">
          <Heading as="h3" size="4">Todavía no tienes proyectos</Heading>
          <Text as="p" color="gray">Crea uno para empezar una conversación guardada.</Text>
        </Card>
      ) : (
        <ul className={styles.projectList}>
          {projects.map((project) => (
            <li key={project.id}>
              <Card className={styles.projectCard} size="3">
                <div className={styles.projectMain}>
                  {editingId === project.id ? (
                    <form className={styles.renameForm} onSubmit={(event) => renameProject(event, project)}>
                      <label className={styles.srOnly} htmlFor={`rename-${project.id}`}>Nuevo nombre de {project.name}</label>
                      <TextField.Root id={`rename-${project.id}`} value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={120} required autoFocus />
                      <Button size="2" type="submit" disabled={busyId === project.id}>Guardar</Button>
                      <Button size="2" variant="soft" onClick={() => setEditingId(null)}>Cancelar</Button>
                    </form>
                  ) : (
                    <>
                      <Heading as="h3" size="4" className={styles.projectName}>
                        <Link href={`/projects/${project.id}`}>{project.name}</Link>
                      </Heading>
                      <Text as="p" size="2" color="gray">Creado {new Date(project.createdAt).toLocaleDateString("es", { dateStyle: "medium" })}</Text>
                    </>
                  )}
                </div>
                {editingId !== project.id ? (
                  <Flex gap="2" wrap="wrap" align="center" className={styles.projectActions}>
                    <Button variant="soft" onClick={() => { setEditName(project.name); setEditingId(project.id); }}>Renombrar</Button>
                    <Dialog.Root
                      open={pendingDelete?.id === project.id}
                      onOpenChange={(open) => { if (open) setPendingDelete(project); else if (busyId !== project.id) setPendingDelete(null); }}
                    >
                      <Dialog.Trigger>
                        <Button variant="outline" color="red">Eliminar</Button>
                      </Dialog.Trigger>
                      <Dialog.Content>
                        <Dialog.Title>Eliminar proyecto</Dialog.Title>
                        <Dialog.Description>
                          Se quitará “{project.name}” de tu espacio. La limpieza de sus archivos y entornos queda registrada para reconciliación.
                        </Dialog.Description>
                        <Flex gap="3" justify="end" mt="5">
                          <Dialog.Close><Button variant="soft" disabled={busyId === project.id}>Cancelar</Button></Dialog.Close>
                          <Button color="red" onClick={deleteProject} disabled={busyId === project.id}>Eliminar proyecto</Button>
                        </Flex>
                      </Dialog.Content>
                    </Dialog.Root>
                  </Flex>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? <div className={styles.more}><Button variant="soft" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "Cargando…" : "Cargar más proyectos"}</Button></div> : null}
      <p className={styles.status} role="status" aria-live="polite">{status}</p>

    </section>
  );
}
