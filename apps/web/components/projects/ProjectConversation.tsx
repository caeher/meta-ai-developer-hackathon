"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge, Button, Card, Heading, Text } from "@radix-ui/themes";
import { TextArea } from "../ui/text-area";
import styles from "./ProjectConversation.module.css";

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

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (payload.error === "not_found") return "El proyecto ya no está disponible.";
  if (payload.error === "authentication_not_configured") return "La autenticación no está configurada.";
  if (payload.error === "idempotency_conflict") return "La solicitud ya se usó con otro contenido.";
  return "No se pudo guardar el mensaje. Puedes volver a intentarlo.";
}

export function ProjectConversation({
  projectId,
  projectName,
  initialMessages,
  initialCursor,
}: {
  projectId: string;
  projectName: string;
  initialMessages: PersistedMessage[];
  initialCursor: string | null;
}) {
  const [messages, setMessages] = useState<DisplayMessage[]>(initialMessages);
  const [nextCursor, setNextCursor] = useState(initialCursor);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [status, setStatus] = useState("");

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
      setContent("");
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
    void send(crypto.randomUUID(), trimmed);
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

  return (
    <main className={styles.workspace}>
      <header className={styles.projectHeader}>
        <div className={styles.breadcrumb}>
          <Link href="/projects">Mis proyectos</Link>
          <span aria-hidden="true">/</span>
          <span>{projectName}</span>
        </div>
        <Badge color="orange" variant="soft">Generación deshabilitada</Badge>
      </header>

      <div className={styles.titleBlock}>
        <Heading as="h1" size="7">{projectName}</Heading>
        <Text as="p" color="gray">Los mensajes se guardan de forma privada y estarán disponibles al volver.</Text>
      </div>

      <Card className={styles.notice} size="2">
        <Text as="p"><strong>Persistencia activa.</strong> El envío guarda tu texto; el agente todavía no ejecuta generación de juegos.</Text>
      </Card>

      <section className={styles.chat} aria-label="Chat persistente del proyecto">
        <div className={styles.transcriptHeader}>
          <Heading as="h2" size="4">Mensajes</Heading>
          <Text as="span" size="2" color="gray">{messages.length} cargados</Text>
        </div>
        {nextCursor ? <Button variant="ghost" onClick={loadEarlier} disabled={loadingEarlier}>{loadingEarlier ? "Cargando…" : "Cargar mensajes anteriores"}</Button> : null}
        <ol className={styles.transcript} aria-label="Transcripción en orden de envío">
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
          {messages.length === 0 ? <li className={styles.empty}><Text as="p" color="gray">Escribe tu primera idea. Quedará guardada en este proyecto.</Text></li> : null}
        </ol>

        <form className={styles.composer} onSubmit={submitMessage}>
          <label htmlFor="project-message">Tu mensaje</label>
          <TextArea
            id="project-message"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Describe una idea para tu juego…"
            rows={4}
            maxLength={100_000}
            required
          />
          <div className={styles.composerFooter}>
            <Text as="span" size="1" color="gray">Máximo 100.000 caracteres. Se envía como texto plano.</Text>
            <Button type="submit" disabled={sending || !content.trim()}>{sending ? "Guardando…" : "Guardar mensaje"}</Button>
          </div>
        </form>
        <p className={styles.status} role="status" aria-live="polite">{status}</p>
      </section>
    </main>
  );
}
