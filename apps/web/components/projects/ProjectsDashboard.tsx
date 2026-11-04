"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
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

interface UsageSummary {
  projects: { used: number; limit: number };
  concurrency: { used: number; limit: number };
  tokens: { used: number; reserved: number; limit: number };
  images: { used: number; reserved: number; limit: number };
  storage: { usedBytes: number; reservedBytes: number; limitBytes: number };
  run: { maxTokens: number; maxDurationMs: number };
}

function formatBytes(value: number): string {
  return value < 1_048_576 ? `${Math.ceil(value / 1_024)} KiB` : `${(value / 1_048_576).toFixed(1)} MiB`;
}

function UsageMeter({ label, used, reserved = 0, limit, display }: { label: string; used: number; reserved?: number; limit: number; display?: string }) {
  const total = Math.max(0, used + reserved);
  const percent = Math.min(100, Math.round((total / Math.max(limit, 1)) * 100));
  return (
    <div className={styles.usageMeter}>
      <div className={styles.usageLabel}><span>{label}</span><span>{display ?? `${used.toLocaleString()} usados${reserved ? ` · ${reserved.toLocaleString()} reservados` : ""} / ${limit.toLocaleString()}`}</span></div>
      <div className={styles.usageTrack} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(total, limit)}>
        <div className={styles.usageFill} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (body.error === "invalid_credentials") return "La contraseña no coincide.";
  if (body.error === "unauthenticated") return "Tu sesión terminó. Inicia sesión de nuevo.";
  if (body.error === "authentication_not_configured") return "La autenticación no está configurada.";
  if (body.error === "not_found") return "El proyecto ya no está disponible.";
  if (body.error === "usage_limit_projects") return "Alcanzaste el máximo de proyectos de tu cuenta.";
  if (body.error === "usage_limit_storage") return "El almacenamiento reservado alcanzó la cuota de tu cuenta.";
  return "No se pudo completar la solicitud. Inténtalo de nuevo.";
}

export function ProjectsDashboard({ initialPage, initialUsage, generationEnabled }: { initialPage: ProjectPage; initialUsage: UsageSummary; generationEnabled: boolean }) {
  const [usage, setUsage] = useState(initialUsage);
  const [projects, setProjects] = useState(initialPage.items);
  const [projectsUsed, setProjectsUsed] = useState(initialUsage.projects.used);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState("");
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [accountPassword, setAccountPassword] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/usage", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const summary = await response.json() as UsageSummary;
        setUsage(summary);
        setProjectsUsed(summary.projects.used);
      } catch { /* Keep the last durable summary while the API is unavailable. */ }
    };
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, []);

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
      setProjectsUsed((current) => current + 1);
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
      setProjectsUsed((current) => Math.max(0, current - 1));
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

  async function deleteAccount() {
    setDeletingAccount(true);
    setStatus("");
    try {
      const response = await fetch("/api/auth/delete-account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: accountPassword }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setDeleteAccountOpen(false);
      window.location.assign("/sign-in");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo eliminar la cuenta.");
    } finally {
      setDeletingAccount(false);
      setAccountPassword("");
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
        <Flex gap="3" wrap="wrap" align="center">
          <Badge color={generationEnabled ? "green" : "cyan"} variant="soft">{generationEnabled ? "Agente listo" : "Generación deshabilitada"}</Badge>
          <Dialog.Root open={deleteAccountOpen} onOpenChange={(open) => { if (!deletingAccount) setDeleteAccountOpen(open); }}>
            <Dialog.Trigger><Button size="2" variant="soft" color="red">Eliminar cuenta</Button></Dialog.Trigger>
            <Dialog.Content>
              <Dialog.Title>Eliminar cuenta</Dialog.Title>
              <Dialog.Description>
                Se cerrarán tus sesiones y el acceso a tus proyectos de inmediato. Los archivos, sandboxes y publicaciones se eliminarán mediante tareas auditables según la retención configurada.
              </Dialog.Description>
              <label className={styles.accountPasswordLabel} htmlFor="delete-account-password">Confirma tu contraseña</label>
              <TextField.Root id="delete-account-password" type="password" autoComplete="current-password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} />
              <Flex gap="3" justify="end" mt="5">
                <Dialog.Close><Button variant="soft" disabled={deletingAccount}>Cancelar</Button></Dialog.Close>
                <Button color="red" onClick={deleteAccount} disabled={deletingAccount || !accountPassword}>{deletingAccount ? "Eliminando…" : "Eliminar cuenta"}</Button>
              </Flex>
            </Dialog.Content>
          </Dialog.Root>
        </Flex>
      </div>

      <Card className={styles.usageCard} size="3">
        <div className={styles.usageHeading}>
          <Heading as="h2" size="4">Uso y límites</Heading>
          <Text size="1" color="gray">Las reservas se cuentan antes de ejecutar un trabajo.</Text>
        </div>
        <div className={styles.usageGrid}>
          <UsageMeter label="Proyectos" used={projectsUsed} limit={usage.projects.limit} display={`${projectsUsed} activos / ${usage.projects.limit}`} />
          <UsageMeter label="Ejecuciones simultáneas" used={usage.concurrency.used} limit={usage.concurrency.limit} />
          <UsageMeter label="Tokens diarios" used={usage.tokens.used} reserved={usage.tokens.reserved} limit={usage.tokens.limit} />
          <UsageMeter label="Imágenes diarias" used={usage.images.used} reserved={usage.images.reserved} limit={usage.images.limit} />
          <UsageMeter label="Storage privado" used={usage.storage.usedBytes} reserved={usage.storage.reservedBytes} limit={usage.storage.limitBytes} display={`${formatBytes(usage.storage.usedBytes)} usados · ${formatBytes(usage.storage.reservedBytes)} reservados / ${formatBytes(usage.storage.limitBytes)}`} />
          <Text className={styles.runLimit}>Por ejecución: hasta {usage.run.maxTokens.toLocaleString()} tokens y {Math.ceil(usage.run.maxDurationMs / 60_000)} min.</Text>
        </div>
      </Card>

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
