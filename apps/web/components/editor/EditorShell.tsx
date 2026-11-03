"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Badge, Button, Dialog, Heading, Tabs, Text, TextField } from "@radix-ui/themes";
import type { EditorProgress, EditorRunStatus, EditorStepStatus } from "@meta-game/contracts";
import { useRunEvents } from "../../hooks/use-run-events";
import { TextArea } from "../ui/text-area";
import { appendPromptText, MAX_PROMPT_LENGTH } from "./prompt";
import { PreviewFrame } from "./preview-frame";
import type { PreviewVersion } from "./preview-toolbar";
import { PublishDialog, type EditorPublication } from "./publish-dialog";
import { AssetToolCard as AssetToolCardView } from "./AssetToolCard";
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

interface PendingRun {
  messageRequestId: string;
  idempotencyKey: string;
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

const EXAMPLE_PROMPTS = [
  { label: "Plataformas 2D", prompt: "Crea un juego de plataformas 2D con 2 niveles, monedas coleccionables y una meta visible. Controles: flechas y espacio." },
  { label: "Puzzle de cajas", prompt: "Crea un puzzle 2D de mover cajas hasta sus metas en 5 niveles cortos, con reinicio de nivel y contador de movimientos." },
  { label: "Shooter top-down", prompt: "Crea un shooter 2D top-down con oleadas de enemigos, vida, puntuación y power-ups ocasionales. Controles: WASD y ratón." },
  { label: "RPG top-down", prompt: "Crea un RPG top-down corto con un mapa, un PNJ con diálogo, una misión simple y una condición de victoria." },
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
  if (payload.error === "publishing_unavailable") return "Las publicaciones están deshabilitadas hasta configurar el origen y el sandbox rootless.";
  return "No se pudo completar la solicitud. Puedes volver a intentarlo.";
}

function isEditorPublication(value: unknown): value is EditorPublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<EditorPublication>;
  return typeof candidate.id === "string" && typeof candidate.versionId === "string" &&
    Number.isSafeInteger(candidate.versionNumber) &&
    (candidate.status === "pending" || candidate.status === "ready" || candidate.status === "failed" || candidate.status === "revoked") &&
    (candidate.idempotencyKey === null || typeof candidate.idempotencyKey === "string") &&
    (candidate.artifactSha256 === null || typeof candidate.artifactSha256 === "string") &&
    (candidate.url === null || typeof candidate.url === "string") && typeof candidate.createdAt === "string";
}

const ISSUE_STATUS_LABELS: Record<string, string> = { pending: "Pendiente", running: "En curso", completed: "Completada", failed: "Fallo" };
const SUBAGENT_STATUS_LABELS: Record<string, string> = { pending: "En espera", running: "Trabajando", succeeded: "Completo", failed: "Fallo" };
const PHASE_LABELS: Record<string, string> = { inventory: "Inventario", "sprite-plan": "Plan de sprites", sprites: "Sprites", "game-plan": "Plan de juego", code: "Codigo", verification: "Verificacion" };
const PHASE_STATUS_LABELS: Record<string, string> = { pending: "Pendiente", running: "En curso", completed: "Completada", failed: "Fallo", skipped: "Omitida" };
const TOOL_STATUS_LABELS: Record<string, string> = { running: "Ejecutando", succeeded: "OK", failed: "Fallo" };

function ProgressView({ view, progress }: { view: "plan" | "steps" | "files" | "verification" | "issues" | "agents" | "activity"; progress?: EditorProgress }) {
  const content = {
    plan: { title: "El plan aparecerá aquí", description: "El plan se mostrará cuando la generación esté disponible." },
    steps: { title: "Aún no hay pasos", description: "El progreso de cada acción se mostrará en esta vista." },
    files: { title: "Aún no hay archivos cambiados", description: "Los cambios se enumerarán cuando exista una ejecución." },
    verification: { title: "Aún no hay verificaciones", description: "Los resultados de lint, build y ejecución se mostrarán aquí." },
    issues: { title: "Sin plan en issues todavia", description: "Cuando el agente principal lo cree, cada issue Markdown (docs/issues/*.md) se listara aqui con su estado." },
    agents: { title: "Sin sub-agentes todavia", description: "El agente principal puede orquestar un sub-agente por issue; aqui veras que hace cada uno." },
    activity: { title: "Sin tool calls todavia", description: "Cada herramienta que llamen el orquestador y los sub-agentes (sprites, atlas, codigo) aparecera aqui y en el chat con su estado." },
  }[view];

  if (progress) {
    return (
      <div className={styles.progressData} aria-live="polite">
        <Badge color="cyan" variant="soft">{RUN_STATUS_LABELS[progress.status]}</Badge>
        {view === "plan" ? <ol>{progress.plan.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol> : null}
        {view === "steps" ? <ol>{progress.steps.map((step) => <li key={step.id}><span>{step.title}</span><Badge color="gray" variant="soft">{STEP_STATUS_LABELS[step.status]}</Badge></li>)}</ol> : null}
        {view === "files" ? <ul>{progress.changedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul> : null}
        {view === "issues" ? <ol>{progress.issues.map((issue) => <li key={`${issue.kind}-${issue.id}`}><span>{issue.id}: {issue.title} <Badge color="gray" variant="soft">{issue.kind}</Badge> <code>{issue.path}</code>{issue.dependsOn.length ? ` - depende de ${issue.dependsOn.join(", ")}` : ""}</span><Badge color="gray" variant="soft">{ISSUE_STATUS_LABELS[issue.status] ?? issue.status}</Badge></li>)}</ol> : null}
        {view === "activity" ? <ol>{progress.toolCalls.map((call) => <li key={call.callId}><span><code>{call.toolName}</code> {call.title}{call.phase ? ` - ${PHASE_LABELS[call.phase] ?? call.phase}` : ""}{call.issueId ? ` - issue ${call.issueId}` : ""}</span><Badge color={call.status === "failed" ? "red" : call.status === "running" ? "cyan" : "green"} variant="soft">{TOOL_STATUS_LABELS[call.status] ?? call.status}</Badge></li>)}</ol> : null}
        {view === "agents" ? <ol>{progress.subagents.map((agent) => <li key={`${agent.kind}-${agent.issueId}`}><span>Sub-agente {agent.kind === "sprites" ? "de sprites" : agent.kind === "game" ? "de codigo" : ""} - {agent.issueId}: {agent.title}{agent.summary ? ` - ${agent.summary}` : ""}</span><Badge color="gray" variant="soft">{SUBAGENT_STATUS_LABELS[agent.status] ?? agent.status}</Badge></li>)}</ol> : null}
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
  publishingEnabled = false,
}: {
  projectId: string;
  projectName: string;
  initialMessages: PersistedMessage[];
  initialCursor: string | null;
  progress?: EditorProgress;
  previewBaseDomain?: string;
  versions?: readonly PreviewVersion[];
  publishingEnabled?: boolean;
}) {
  const runEvents = useRunEvents(projectId);
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
  const [publications, setPublications] = useState<EditorPublication[]>([]);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [publishVersionId, setPublishVersionId] = useState(versions.find((version) => version.status === "ready")?.id ?? "");
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [publicationNotice, setPublicationNotice] = useState("");
  const pendingPublishRequest = useRef<{ versionId: string; key: string } | null>(null);
  const recoveredPublications = useRef(new Set<string>());
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  const pendingRunRestored = useRef(false);
  const displayProgress = runEvents.progress ?? progress;
  const pendingRunStorageKey = `meta-game:pending-run:${projectId}`;

  const refreshPublications = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/publications`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { items?: unknown };
    if (!Array.isArray(payload.items)) return;
    setPublications(payload.items.filter(isEditorPublication));
  }, [projectId]);

  useEffect(() => {
    if (!publishingEnabled) return;
    void refreshPublications();
  }, [publishingEnabled, refreshPublications]);

  useEffect(() => {
    if (!publishingEnabled || !publications.some((publication) => publication.status === "pending")) return;
    const interval = window.setInterval(() => { void refreshPublications(); }, 2_000);
    return () => window.clearInterval(interval);
  }, [publishingEnabled, publications, refreshPublications]);

  useEffect(() => {
    if (!publishingEnabled) return;
    for (const publication of publications) {
      if (publication.status !== "pending" || !publication.idempotencyKey || recoveredPublications.current.has(publication.id)) continue;
      recoveredPublications.current.add(publication.id);
      void fetch(`/api/projects/${projectId}/publications`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId: publication.versionId, idempotencyKey: publication.idempotencyKey }),
      }).then(() => refreshPublications()).catch(() => undefined);
    }
  }, [publishingEnabled, publications, projectId, refreshPublications]);

  useEffect(() => {
    if (runEvents.hydrating || pendingRunRestored.current) return;
    pendingRunRestored.current = true;
    try {
      const raw = window.localStorage.getItem(pendingRunStorageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const candidate = parsed as Partial<PendingRun>;
      if (typeof candidate.messageRequestId !== "string" || typeof candidate.idempotencyKey !== "string") return;
      if (runEvents.latestMessageRequestId === candidate.messageRequestId) {
        window.localStorage.removeItem(pendingRunStorageKey);
        return;
      }
      setPendingRun({ messageRequestId: candidate.messageRequestId, idempotencyKey: candidate.idempotencyKey });
    } catch {
      window.localStorage.removeItem(pendingRunStorageKey);
    }
  }, [pendingRunStorageKey, runEvents.hydrating, runEvents.latestMessageRequestId]);

  useEffect(() => {
    if (runEvents.active) setQuickOptionsOpen(false);
  }, [runEvents.active]);

  function rememberPendingRun(next: PendingRun | null) {
    setPendingRun(next);
    try {
      if (next) window.localStorage.setItem(pendingRunStorageKey, JSON.stringify(next));
      else window.localStorage.removeItem(pendingRunStorageKey);
    } catch {
      // The API remains idempotent for the current interaction if browser storage is unavailable.
    }
  }

  async function send(requestId: string, messageContent: string) {
    if (runEvents.hydrating || runEvents.active) return;
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
      const nextPendingRun = { messageRequestId: saved.requestId, idempotencyKey: requestId };
      rememberPendingRun(nextPendingRun);
      try {
        await runEvents.enqueue(nextPendingRun.messageRequestId, nextPendingRun.idempotencyKey);
        rememberPendingRun(null);
        setStatus("Mensaje guardado y ejecución en cola.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "El mensaje quedó guardado, pero no se pudo encolar.");
      }
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
    if (!trimmed || sending || runEvents.working || runEvents.hydrating || runEvents.active) return;
    void send(globalThis.crypto.randomUUID(), trimmed);
  }

  async function retryPendingRun() {
    if (!pendingRun || runEvents.working || runEvents.active) return;
    try {
      await runEvents.enqueue(pendingRun.messageRequestId, pendingRun.idempotencyKey);
      rememberPendingRun(null);
      setStatus("Ejecución en cola.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo reintentar la ejecución.");
    }
  }

  async function retryLastRun() {
    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
    const messageRequestId = runEvents.latestMessageRequestId ?? lastUserMessage?.requestId;
    if (!messageRequestId || runEvents.active || runEvents.working) return;
    const nextPendingRun = { messageRequestId, idempotencyKey: globalThis.crypto.randomUUID() };
    rememberPendingRun(nextPendingRun);
    try {
      await runEvents.enqueue(nextPendingRun.messageRequestId, nextPendingRun.idempotencyKey);
      rememberPendingRun(null);
      setStatus("Nuevo intento en cola.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo iniciar un nuevo intento.");
    }
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

  async function publishVersion(versionId: string, idempotencyKey?: string) {
    if (!publishingEnabled || publicationBusy || !versionId) return;
    setPublicationBusy(true);
    setPublicationNotice("");
    const pending = pendingPublishRequest.current;
    const key = idempotencyKey ?? (pending?.versionId === versionId ? pending.key : globalThis.crypto.randomUUID());
    if (!idempotencyKey) pendingPublishRequest.current = { versionId, key };
    try {
      const response = await fetch(`/api/projects/${projectId}/publications`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId, idempotencyKey: key }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      pendingPublishRequest.current = null;
      setPublishConfirmed(false);
      setPublishDialogOpen(true);
      setPublicationNotice("Build estática en cola. El historial se actualizará al terminar.");
      await refreshPublications();
    } catch (error) {
      setPublicationNotice(error instanceof Error ? error.message : "No se pudo iniciar la publicación.");
    } finally { setPublicationBusy(false); }
  }

  async function revokePublication(publication: EditorPublication) {
    if (publicationBusy) return;
    setPublicationBusy(true);
    setPublicationNotice("");
    try {
      const response = await fetch(`/api/projects/${projectId}/publications/${publication.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response));
      setPublicationNotice("Publicación revocada. El origen dejará de servirla; las cachés expiran en 60 segundos.");
      await refreshPublications();
    } catch (error) {
      setPublicationNotice(error instanceof Error ? error.message : "No se pudo revocar la publicación.");
    } finally { setPublicationBusy(false); }
  }

  async function sharePublication(publication: EditorPublication) {
    if (publication.status !== "ready" || !publication.url) return;
    try {
      await navigator.clipboard.writeText(publication.url);
      setPublicationNotice("URL pública copiada.");
    } catch {
      setPublicationNotice("No se pudo copiar la URL. Ábrela desde el historial de publicaciones.");
    }
  }

  function retryPublication(publication: EditorPublication) {
    if (!publication.idempotencyKey) return;
    void publishVersion(publication.versionId, publication.idempotencyKey);
  }

  function shareLatestPublication() {
    const latest = publications.find((publication) => publication.status === "ready" && publication.url);
    if (latest) void sharePublication(latest);
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
            <Button variant="ghost" size="1" aria-label={`Editar nombre de ${projectName}`} disabled={runEvents.active || runEvents.working}>Editar nombre</Button>
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
          {!publishingEnabled ? <span className={styles.publishHint}>Sin build verificada: Publish y Share están desactivados.</span> : null}
          <PublishDialog
            enabled={publishingEnabled}
            open={publishDialogOpen}
            onOpenChange={(open) => { setPublishDialogOpen(open); if (!open) setPublishConfirmed(false); }}
            versions={versions}
            selectedVersionId={publishVersionId}
            onVersionChange={setPublishVersionId}
            confirmed={publishConfirmed}
            onConfirmedChange={setPublishConfirmed}
            publishing={publicationBusy}
            onPublish={() => void publishVersion(publishVersionId)}
            publications={publications}
            onShare={(publication) => void sharePublication(publication)}
            onRevoke={(publication) => void revokePublication(publication)}
            onRetry={retryPublication}
          />
          <Button variant="soft" disabled={!publishingEnabled || !publications.some((publication) => publication.status === "ready" && publication.url)} onClick={shareLatestPublication} title="Copia la URL de la publicación lista más reciente">Share</Button>
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
                <Tabs.Trigger value="issues">Issues</Tabs.Trigger>
                <Tabs.Trigger value="agents">Agentes</Tabs.Trigger>
                <Tabs.Trigger value="activity">Actividad</Tabs.Trigger>
              </Tabs.List>
              <Dialog.Root open={quickOptionsOpen} onOpenChange={setQuickOptionsOpen}>
                <Dialog.Trigger>
                  <Button variant="soft" size="2" disabled={runEvents.active || runEvents.working || runEvents.hydrating}>Opciones rápidas</Button>
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
                              disabled={runEvents.active || runEvents.working || runEvents.hydrating}
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
                <Badge color={runEvents.active ? "cyan" : runEvents.enabled === false ? "orange" : "gray"} variant="soft">
                  {runEvents.run ? RUN_STATUS_LABELS[runEvents.run.status] : runEvents.hydrating ? "Recuperando ejecución" : runEvents.enabled === false ? "Generación deshabilitada" : "Agente listo"}
                </Badge>
                <Text as="p" size="1">
                  {runEvents.active
                    ? runEvents.run?.cancelRequested ? "Detención solicitada; esperando al worker." : "El agente está trabajando. Puedes revisar el plan y los cambios en las pestañas."
                    : runEvents.enabled === false ? "El worker y el sandbox no están habilitados en este entorno. Los mensajes se conservan y el enqueue queda disponible para reintento."
                      : `Progreso: ${runEvents.connection === "connected" ? "conectado" : runEvents.connection === "reconnecting" ? "reconectando" : runEvents.connection === "connecting" ? "conectando" : "en espera"}.`}
                </Text>
                {runEvents.active ? (
                  <Button variant="soft" color="red" size="1" onClick={() => void runEvents.cancel()} disabled={runEvents.working || runEvents.run?.cancelRequested}>
                    {runEvents.run?.cancelRequested ? "Deteniendo…" : "Detener"}
                  </Button>
                ) : null}
                {pendingRun ? (
                  <Button variant="soft" size="1" onClick={() => void retryPendingRun()} disabled={runEvents.working || runEvents.active}>
                    Reintentar ejecución
                  </Button>
                ) : null}
                {!pendingRun && runEvents.run && (runEvents.run.status === "failed" || runEvents.run.status === "cancelled") ? (
                  <Button variant="soft" size="1" onClick={() => void retryLastRun()} disabled={runEvents.working || runEvents.active}>
                    Reintentar generación
                  </Button>
                ) : null}
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
                      {message.delivery === "failed" ? <Button variant="ghost" size="1" onClick={() => void send(message.requestId, message.content)} disabled={runEvents.active || runEvents.working}>Reintentar guardado</Button> : null}
                    </div>
                    <p>{message.content}</p>
                  </li>
                ))}
                {runEvents.assistantSummary ? (
                  <li key={`run-summary-${runEvents.run?.id ?? "latest"}`} className={styles.agentMessage}>
                    <div className={styles.messageMeta}><Text as="span" size="1">Agente</Text></div>
                    <p>{runEvents.assistantSummary}</p>
                  </li>
                ) : null}
                {displayProgress && displayProgress.phases.length ? (
                  <li key="agentic-phases" className={styles.agentMessage}>
                    <div className={styles.messageMeta}><Text as="span" size="1">Flujo agentico</Text></div>
                    <ol aria-label="Fases del flujo agentico">
                      {displayProgress.phases.map((phase) => (
                        <li key={phase.phase}><span>{PHASE_LABELS[phase.phase] ?? phase.phase}{phase.summary ? `: ${phase.summary}` : ""}</span> <Badge color={phase.status === "failed" ? "red" : phase.status === "running" ? "cyan" : phase.status === "completed" ? "green" : "gray"} variant="soft">{PHASE_STATUS_LABELS[phase.status] ?? phase.status}</Badge></li>
                      ))}
                    </ol>
                  </li>
                ) : null}
                {displayProgress?.toolCalls.map((call) => (
                  <li key={`tool-call-${call.callId}`} className={styles.agentMessage}>
                    <div className={styles.messageMeta}>
                      <Text as="span" size="1">Tool call{call.issueId ? ` - ${call.issueId}` : ""}</Text>
                      <Badge color={call.status === "failed" ? "red" : call.status === "running" ? "cyan" : "green"} variant="soft">{TOOL_STATUS_LABELS[call.status] ?? call.status}</Badge>
                    </div>
                    <p><code>{call.toolName}</code> - {call.title}{call.phase ? ` (${PHASE_LABELS[call.phase] ?? call.phase})` : ""}</p>
                  </li>
                ))}
                {displayProgress?.subagents.filter((agent) => agent.status === "running" || agent.summary).map((agent) => (
                  <li key={`chat-subagent-${agent.kind}-${agent.issueId}`} className={styles.agentMessage}>
                    <div className={styles.messageMeta}><Text as="span" size="1">Sub-agente {agent.kind}</Text><Badge color="gray" variant="soft">{SUBAGENT_STATUS_LABELS[agent.status] ?? agent.status}</Badge></div>
                    <p>{agent.issueId}: {agent.title}{agent.summary ? ` - ${agent.summary}` : ""}</p>
                  </li>
                ))}
                {runEvents.progress?.assetCards.map((card) => (
                  <li key={`asset-card-${card.callId}`} className={styles.assetCardItem}>
                    <AssetToolCardView card={card} projectId={projectId} />
                  </li>
                ))}
                {messages.length === 0 ? (
                  <li className={styles.emptyTranscript}>
                    <div>
                      <Text as="p" color="gray">Tus mensajes privados aparecerán aquí.</Text>
                      <div className={styles.emptyExamples} role="group" aria-label="Ideas de ejemplo">
                        {EXAMPLE_PROMPTS.map((example) => (
                          <Button key={example.label} variant="soft" size="2" aria-label={`Ejemplo: ${example.label}`} disabled={runEvents.active || runEvents.working || runEvents.hydrating || sending} onClick={() => { setContent(example.prompt); setStatus("Ejemplo añadido al borrador. Edítalo y envíalo cuando quieras."); }}>
                            {example.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </li>
                ) : null}
              </ol>
              <form className={styles.composer} onSubmit={submitMessage}>
                <label htmlFor="editor-prompt">Describe tu juego</label>
                <TextArea
                  id="editor-prompt"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Describe una idea para tu juego…"
                  disabled={runEvents.active || runEvents.working || runEvents.hydrating || sending}
                  rows={2}
                  maxLength={MAX_PROMPT_LENGTH}
                  aria-describedby="editor-prompt-hint"
                  required
                />
                <div className={styles.composerFooter}>
                  <Text id="editor-prompt-hint" as="span" size="1" color="gray">Máximo 100.000 caracteres. El mensaje queda privado y se envía a Meta al ejecutar.</Text>
                  <Button type="submit" disabled={sending || runEvents.working || runEvents.active || runEvents.hydrating || !content.trim()}>
                    {sending || runEvents.working ? "Encolando…" : runEvents.hydrating ? "Recuperando…" : "Enviar al agente"}
                  </Button>
                </div>
                <Text size="1" color="gray">No incluir datos personales, secretos ni información confidencial. Al ejecutar aceptaste los términos Contributor y la mayoría de edad en el registro.</Text>
              </form>
              <p className={styles.chatStatus} role="status" aria-live="polite">{status || runEvents.error || publicationNotice}</p>
            </Tabs.Content>
            <Tabs.Content value="plan" className={styles.progressContent}>
              <ProgressView view="plan" progress={displayProgress} />
            </Tabs.Content>
            <Tabs.Content value="steps" className={styles.progressContent}>
              <ProgressView view="steps" progress={displayProgress} />
            </Tabs.Content>
            <Tabs.Content value="files" className={styles.progressContent}>
              <ProgressView view="files" progress={displayProgress} />
            </Tabs.Content>
            <Tabs.Content value="verification" className={styles.progressContent}>
              <ProgressView view="verification" progress={displayProgress} />
            </Tabs.Content>
            <Tabs.Content value="issues" className={styles.progressContent}>
              <ProgressView view="issues" progress={displayProgress} />
            </Tabs.Content>
            <Tabs.Content value="agents" className={styles.progressContent}>
              <ProgressView view="agents" progress={displayProgress} />
            </Tabs.Content>
            <Tabs.Content value="activity" className={styles.progressContent}>
              <ProgressView view="activity" progress={displayProgress} />
            </Tabs.Content>
          </Tabs.Root>
        </section>

        <section className={styles.previewPane} aria-label="Vista previa privada del juego">
          <PreviewFrame projectId={projectId} baseDomain={previewBaseDomain} versions={versions} refreshRevision={runEvents.previewRevision} />
        </section>
      </div>
    </section>
  );
}
