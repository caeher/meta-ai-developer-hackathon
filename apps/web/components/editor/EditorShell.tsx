"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Badge, Button, Dialog, Heading, Tabs, Text, TextField } from "@radix-ui/themes";
import type { EditorProgress, EditorRunStatus, EditorStepStatus } from "@meta-game/contracts";
import { TextArea } from "../ui/text-area";
import { appendPromptText, MAX_PROMPT_LENGTH } from "./prompt";
import { PreviewFrame } from "./preview-frame";
import type { PreviewVersion } from "./preview-toolbar";
import styles from "./EditorShell.module.css";

export interface PersistedMessage {
  id: string;
  projectId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  requestId: string;
  sequence: number;
  createdAt: string | Date;
}

interface DisplayMessage extends PersistedMessage {
  delivery?: "sending" | "failed";
}

interface MessagePage {
  items: PersistedMessage[];
  nextCursor: string | null;
}

interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

const QUICK_PROMPT_GROUPS = [
  {
    id: "genre",
    title: "Género",
    options: [
      ["Plataformas 2D", "Género: plataformas 2D."],
      ["Shooter 2D", "Género: shooter 2D."],
      ["Puzzle", "Género: puzzle."],
      ["RPG top-down", "Género: RPG top-down."],
    ],
  },
  {
    id: "art-controls",
    title: "Arte y controles",
    options: [
      ["Pixel art", "Estilo de arte: pixel art."],
      ["Ilustrado", "Estilo de arte: ilustración dibujada a mano."],
      ["Teclado", "Controles: teclado."],
      ["Touch", "Controles táctiles para móvil."],
      ["Gamepad", "Controles con gamepad."],
    ],
  },
  {
    id: "content",
    title: "Mecánicas y contenido",
    options: [
      ["Mecánicas", "Incluye mecánicas claras y una condición de victoria."],
      ["Sprites", "Necesito sprites para los personajes y objetos."],
      ["Fondos", "Incluye fondos para las escenas."],
      ["Niveles", "Añade varios niveles con dificultad progresiva."],
      ["Enemigos", "Añade enemigos con patrones legibles."],
    ],
  },
  {
    id: "sound",
    title: "Sonido",
    options: [
      ["Efectos de sonido", "Añade efectos de sonido y un control para silenciarlos."],
      ["Música", "Incluye música de fondo con un control para silenciarla."],
    ],
  },
] as const;

const RUN_STATUS_LABELS: Record<EditorRunStatus, string> = {
  queued: "En cola",
  planning: "Planificando",
  running: "En ejecución",
  verifying: "Verificando",
  succeeded: "Completado",
  failed: "Falló",
  cancelled: "Cancelado",
};

const STEP_STATUS_LABELS: Record<EditorStepStatus, string> = {
  pending: "Pendiente",
  running: "En curso",
  succeeded: "Completado",
  failed: "Falló",
  skipped: "Omitido",
};

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (payload.error === "not_found") return "El proyecto ya no está disponible.";
  if (payload.error === "authentication_not_configured") return "La autenticación no está configurada.";
  if (payload.error === "idempotency_conflict") return "La solicitud ya se usó con otro contenido.";
  if (payload.error === "origin_not_allowed") return "No se pudo verificar el origen de la solicitud.";
  return "No se pudo completar la solicitud. Puedes volver a intentarlo.";
}

function ProgressView({ view, progress }: { view: "plan" | "steps" | "files" | "verification"; progress?: EditorProgress }) {
  const content = {
    plan: { title: "El plan aparecerá aquí", description: "El plan se mostrará cuando la generación esté disponible." },
    steps: { title: "Aún no hay pasos", description: "El progreso de cada acción se mostrará en esta vista." },
    files: { title: "Aún no hay archivos cambiados", description: "Los cambios se enumerarán cuando exista una ejecución." },
    verification: { title: "Aún no hay verificaciones", description: "Los resultados de lint, build y ejecución se mostrarán aquí." },
  }[view];

  if (progress) {
    return (
      <div className={styles.progressData} aria-live="polite">
        <Badge color="cyan" variant="soft">{RUN_STATUS_LABELS[progress.status]}</Badge>
        {view === "plan" ? <ol>{progress.plan.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol> : null}
        {view === "steps" ? <ol>{progress.steps.map((step) => <li key={step.id}><span>{step.title}</span><Badge color="gray" variant="soft">{STEP_STATUS_LABELS[step.status]}</Badge></li>)}</ol> : null}
        {view === "files" ? <ul>{progress.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : null}
        {view === "verification" ? (
          <div className={styles.verificationResult}>
            <Badge color="gray" variant="soft">{progress.verification.status}</Badge>
            <Text as="p">{progress.verification.summary ?? "Sin resumen de verificación."}</Text>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.progressEmpty}>
      <Badge color="gray" variant="soft">Sin ejecuciones</Badge>
      <Heading as="h3" size="3">{content.title}</Heading>
      <Text as="p" color="gray">{content.description}</Text>
    </div>
  );
}

export function EditorShell({
  projectId,
  projectName: initialProjectName,
  initialMessages,
  initialCursor,
  progress,
  previewBaseDomain,
  versions = [],
}: {
  projectId: string;
  projectName: string;
  initialMessages: PersistedMessage[];
  initialCursor: string | null;
  progress?: EditorProgress;
  previewBaseDomain?: string;
  versions?: readonly PreviewVersion[];
}) {
  const [projectName, setProjectName] = useState(initialProjectName);
  const [messages, setMessages] = useState<DisplayMessage[]>(initialMessages);
  const [nextCursor, setNextCursor] = useState(initialCursor);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [status, setStatus] = useState("");
  const [mobilePane, setMobilePane] = useState<"chat" | "preview">("chat");
  const [quickOptionsOpen, setQuickOptionsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(initialProjectName);
  const [renaming, setRenaming] = useState(false);

  async function send(requestId: string, messageContent: string) {
    setSending(true);
    setStatus("");
    setMessages((current) => {
      if (current.some((message) => message.requestId === requestId)) {
        return current.map((message) => message.requestId === requestId ? { ...message, delivery: "sending" } : message);
      }
      const sequence = (current.at(-1)?.sequence ?? 0) + 1;
      return [...current, {
        id: `pending-${requestId}`,
        projectId,
        role: "user",
        content: messageContent,
        requestId,
        sequence,
        createdAt: new Date(),
        delivery: "sending",
      }];
    });
    try {
      const response = await fetch(`/api/projects/${projectId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, content: messageContent }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const saved = await response.json() as PersistedMessage;
      setMessages((current) => {
        const reconciled = current.filter((message) => message.requestId !== requestId || message.id === saved.id);
        return reconciled.some((message) => message.id === saved.id)
          ? reconciled.map((message) => message.id === saved.id ? saved : message)
          : [...reconciled, saved].sort((left, right) => left.sequence - right.sequence);
      });
      setContent((current) => current === messageContent ? "" : current);
      setStatus("Mensaje guardado. El agente todavía no ejecuta generación.");
    } catch (error) {
      setMessages((current) => current.map((message) => message.requestId === requestId ? { ...message, delivery: "failed" } : message));
      setStatus(error instanceof Error ? error.message : "No se pudo guardar el mensaje.");
    } finally {
      setSending(false);
    }
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    void send(globalThis.crypto.randomUUID(), trimmed);
  }

  async function loadEarlier() {
    if (!nextCursor) return;
    setLoadingEarlier(true);
    setStatus("");
    try {
      const query = new URLSearchParams({ limit: "50", cursor: nextCursor });
      const response = await fetch(`/api/projects/${projectId}/messages?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const page = await response.json() as MessagePage;
      setMessages((current) => {
        const known = new Set(current.map((message) => message.id));
        return [...page.items.filter((message) => !known.has(message.id)), ...current]
          .sort((left, right) => left.sequence - right.sequence);
      });
      setNextCursor(page.nextCursor);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudieron cargar mensajes anteriores.");
    } finally {
      setLoadingEarlier(false);
    }
  }

  async function renameProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = nameDraft.trim();
    if (!nextName || renaming) return;
    setRenaming(true);
    setStatus("");
    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nextName }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const updated = await response.json() as ProjectSummary;
      setProjectName(updated.name);
      setNameDraft(updated.name);
      setRenameOpen(false);
      setStatus("Nombre del proyecto actualizado.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo renombrar el proyecto.");
    } finally {
      setRenaming(false);
    }
  }

  function insertQuickOption(value: string) {
    const next = appendPromptText(content, value);
    setContent(next);
    setStatus(next === content && content.length >= MAX_PROMPT_LENGTH
      ? "El borrador alcanzó el máximo de 100.000 caracteres. Acorta el texto antes de añadir más opciones."
      : "Opción añadida al borrador. Puedes editarla antes de guardar.");
  }

  return (
    <section className={styles.editor} aria-label={`Editor de ${projectName}`}>
      <header className={styles.projectBar}>
        <div className={styles.projectIdentity}>
          <div className={styles.breadcrumb}>
            <Link href="/projects">Mis proyectos</Link>
            <span aria-hidden="true">/</span>
            <h1>{projectName}</h1>
          </div>
          <Dialog.Root open={renameOpen} onOpenChange={(open) => { setRenameOpen(open); if (open) setNameDraft(projectName); }}>
            <Dialog.Trigger>
              <Button variant="ghost" size="1" aria-label={`Editar nombre de ${projectName}`}>Editar nombre</Button>
            </Dialog.Trigger>
            <Dialog.Content maxWidth="420px">
              <Dialog.Title>Renombrar proyecto</Dialog.Title>
              <Dialog.Description>El nuevo nombre se guardará en tu proyecto privado.</Dialog.Description>
              <form className={styles.renameForm} onSubmit={renameProject}>
                <label htmlFor="editor-project-name">Nombre del proyecto</label>
                <TextField.Root
                  id="editor-project-name"
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  maxLength={120}
                  autoFocus
                  required
                />
                <div className={styles.dialogActions}>
                  <Dialog.Close>
                    <Button variant="soft" disabled={renaming}>Cancelar</Button>
                  </Dialog.Close>
                  <Button type="submit" disabled={renaming || !nameDraft.trim()}>{renaming ? "Guardando…" : "Guardar nombre"}</Button>
                </div>
              </form>
            </Dialog.Content>
          </Dialog.Root>
        </div>
        <div className={styles.projectActions}>
          <Button variant="soft" disabled title="Publicar estará disponible cuando exista una build verificada." aria-describedby="editor-pending-note">Publish</Button>
          <Button variant="soft" disabled title="Compartir estará disponible cuando exista una publicación." aria-describedby="editor-pending-note">Share</Button>
        </div>
        <span id="editor-pending-note" className={styles.srOnly}>Publish y Share estarán disponibles cuando exista una build publicada. Guardar un mensaje no inicia una ejecución.</span>
      </header>

      <div className={styles.mobilePaneSwitch} role="group" aria-label="Panel visible">
        <Button variant={mobilePane === "chat" ? "solid" : "soft"} aria-pressed={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>Chat</Button>
        <Button variant={mobilePane === "preview" ? "solid" : "soft"} aria-pressed={mobilePane === "preview"} onClick={() => setMobilePane("preview")}>Preview</Button>
      </div>

      <div className={styles.workspace} data-active-pane={mobilePane}>
        <section className={styles.chatPane} aria-label="Chat y progreso">
          <Tabs.Root defaultValue="chat" className={styles.chatTabs}>
            <div className={styles.chatToolbar}>
              <Tabs.List aria-label="Vistas del progreso" className={styles.progressTabs}>
                <Tabs.Trigger value="chat">Chat</Tabs.Trigger>
                <Tabs.Trigger value="plan">Plan</Tabs.Trigger>
                <Tabs.Trigger value="steps">Pasos</Tabs.Trigger>
                <Tabs.Trigger value="files">Archivos</Tabs.Trigger>
                <Tabs.Trigger value="verification">Verificación</Tabs.Trigger>
              </Tabs.List>
              <Dialog.Root open={quickOptionsOpen} onOpenChange={setQuickOptionsOpen}>
                <Dialog.Trigger>
                  <Button variant="soft" size="2">Opciones rápidas</Button>
                </Dialog.Trigger>
                <Dialog.Content className={styles.quickOptionsDialog} maxWidth="640px">
                  <Dialog.Title>Opciones rápidas</Dialog.Title>
                  <Dialog.Description>Inserta ideas en el borrador. Puedes editarlas y guardar el mensaje cuando esté listo.</Dialog.Description>
                  <div className={styles.quickOptionsGroups}>
                    {QUICK_PROMPT_GROUPS.map((group) => (
                      <section key={group.id} aria-labelledby={`quick-group-${group.id}`}>
                        <Heading as="h3" size="3" id={`quick-group-${group.id}`}>{group.title}</Heading>
                        <div className={styles.quickOptionsGrid}>
                          {group.options.map(([label, prompt]) => (
                            <Button
                              key={label}
                              variant="outline"
                              onClick={() => insertQuickOption(prompt)}
                              aria-label={`Insertar: ${label}`}
                            >
                              {label}
                            </Button>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                  <div className={styles.dialogActions}>
                    <Dialog.Close><Button>Cerrar</Button></Dialog.Close>
                  </div>
                </Dialog.Content>
              </Dialog.Root>
            </div>

            <Tabs.Content value="chat" className={styles.chatContent}>
              <div className={styles.agentNotice}>
                <Badge color="orange" variant="soft">Generación deshabilitada</Badge>
                <Text as="p" size="1">Guardar un mensaje no inicia una ejecución del agente.</Text>
              </div>
              {nextCursor ? (
                <div className={styles.earlierButton}>
                  <Button variant="ghost" onClick={loadEarlier} disabled={loadingEarlier}>
                    {loadingEarlier ? "Cargando…" : "Cargar mensajes anteriores"}
                  </Button>
                </div>
              ) : null}
              <ol className={styles.transcript} aria-label="Transcripción privada en orden de envío">
                {messages.map((message) => (
                  <li key={message.id} className={message.role === "user" ? styles.userMessage : styles.agentMessage}>
                    <div className={styles.messageMeta}>
                      <Text as="span" size="1">{message.role === "user" ? "Tú" : message.role === "assistant" ? "Agente" : "Herramienta"}</Text>
                      {message.delivery === "sending" ? <Text as="span" size="1" color="gray">Guardando…</Text> : null}
                      {message.delivery === "failed" ? <Button variant="ghost" size="1" onClick={() => void send(message.requestId, message.content)}>Reintentar guardado</Button> : null}
                    </div>
                    <p>{message.content}</p>
                  </li>
                ))}
                {messages.length === 0 ? (
                  <li className={styles.emptyTranscript}><Text as="p" color="gray">Tus mensajes privados aparecerán aquí.</Text></li>
                ) : null}
              </ol>
              <form className={styles.composer} onSubmit={submitMessage}>
                <label htmlFor="editor-prompt">Describe tu juego</label>
                <TextArea
                  id="editor-prompt"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Describe una idea para tu juego…"
                  rows={3}
                  maxLength={MAX_PROMPT_LENGTH}
                  aria-describedby="editor-prompt-hint"
                  required
                />
                <div className={styles.composerFooter}>
                  <Text id="editor-prompt-hint" as="span" size="1" color="gray">Máximo 100.000 caracteres. Se guarda como texto plano.</Text>
                  <Button type="submit" disabled={sending || !content.trim()}>{sending ? "Guardando…" : "Guardar mensaje"}</Button>
                </div>
              </form>
              <p className={styles.chatStatus} role="status" aria-live="polite">{status}</p>
            </Tabs.Content>
            <Tabs.Content value="plan" className={styles.progressContent}>
              <ProgressView view="plan" progress={progress} />
            </Tabs.Content>
            <Tabs.Content value="steps" className={styles.progressContent}>
              <ProgressView view="steps" progress={progress} />
            </Tabs.Content>
            <Tabs.Content value="files" className={styles.progressContent}>
              <ProgressView view="files" progress={progress} />
            </Tabs.Content>
            <Tabs.Content value="verification" className={styles.progressContent}>
              <ProgressView view="verification" progress={progress} />
            </Tabs.Content>
          </Tabs.Root>
        </section>

        <section className={styles.previewPane} aria-label="Vista previa privada del juego">
          <PreviewFrame projectId={projectId} baseDomain={previewBaseDomain} versions={versions} />
        </section>
      </div>
    </section>
  );
}
