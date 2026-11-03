"use client";

import { useCallback, useEffect, useState } from "react";
import {
  EditorProgressSchema,
  RunResponseSchema,
  RunStreamEventSchema,
  type EditorProgress,
  type RunResponse,
  type RunStreamEvent,
} from "@meta-game/contracts";

type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting";

const activeStatuses = new Set(["queued", "planning", "running", "verifying"]);

function emptyProgress(status: RunResponse["status"]): EditorProgress {
  return EditorProgressSchema.parse({
    status,
    plan: [],
    steps: [],
    changedFiles: [],
    assetCards: [],
    verification: { status: "pending" },
  });
}

function runErrorMessage(code: unknown): string {
  if (code === "orchestrator_pending") return "La ejecución no está habilitada en este entorno. El mensaje quedó guardado y puedes reintentar cuando el worker y el sandbox estén disponibles.";
  if (code === "project_run_busy") return "Este proyecto ya tiene una ejecución activa.";
  if (code === "usage_limit_tokens") return "Se alcanzó la cuota diaria de tokens; revisa el uso consumido y reservado en Proyectos.";
  if (code === "usage_limit_images") return "Se alcanzó la cuota diaria de imágenes; revisa el uso consumido y reservado en Proyectos.";
  if (code === "usage_limit_concurrency") return "Ya tienes todas las ejecuciones simultáneas permitidas en curso.";
  if (code === "usage_limit_storage") return "Se alcanzó la cuota de almacenamiento privado; libera espacio antes de generar más assets o versiones.";
  if (code === "usage_limit_projects") return "Se alcanzó el máximo de proyectos de la cuenta.";
  if (code === "usage_limit_time") return "La ejecución alcanzó el límite de tiempo configurado.";
  if (code === "not_found") return "El proyecto o la ejecución ya no está disponible.";
  if (code === "contributor_consent_required") return "Confirma los términos de uso de Meta y el requisito de edad antes de iniciar.";
  if (code === "unauthenticated" || code === "authentication_not_configured") return "Inicia sesión para ejecutar el agente.";
  return "No se pudo iniciar la ejecución. Puedes reintentarlo sin duplicar el run.";
}

export async function enqueueProjectRun(projectId: string, messageRequestId: string, idempotencyKey: string): Promise<RunResponse> {
  const response = await fetch(`/api/projects/${projectId}/runs`, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey, messageRequestId, contributorConsent: true }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    const error = new Error(runErrorMessage(payload.error));
    Object.assign(error, { code: payload.error });
    throw error;
  }
  const payload = await response.json() as { run?: unknown };
  return RunResponseSchema.parse(payload.run);
}

function updateProgress(current: EditorProgress, event: RunStreamEvent): EditorProgress {
  const next = {
    ...current,
    plan: [...current.plan],
    steps: [...current.steps],
    changedFiles: [...current.changedFiles],
    assetCards: [...current.assetCards],
    verification: { ...current.verification },
  };
  switch (event.type) {
    case "run.queued":
      next.status = "queued";
      break;
    case "run.status":
      next.status = event.payload.status;
      break;
    case "run.cancel_requested":
      break;
    case "plan.created":
      next.plan = [event.payload.objective, ...event.payload.steps.map((step) => step.title)].slice(0, 40);
      next.steps = event.payload.steps.map((step) => ({ id: step.id, title: step.title, status: "pending" as const }));
      break;
    case "step.started": {
      const index = next.steps.findIndex((step) => step.id === event.payload.stepId);
      const step = { id: event.payload.stepId, title: event.payload.title, status: "running" as const };
      if (index < 0) next.steps = [...next.steps, step].slice(0, 100);
      else next.steps[index] = step;
      break;
    }
    case "step.completed": {
      const index = next.steps.findIndex((step) => step.id === event.payload.stepId);
      const step = { id: event.payload.stepId, title: event.payload.title, status: event.payload.status };
      if (index < 0) next.steps = [...next.steps, step].slice(0, 100);
      else next.steps[index] = step;
      break;
    }
    case "file.changed":
      if (!next.changedFiles.includes(event.payload.path)) next.changedFiles = [...next.changedFiles, event.payload.path].slice(-100);
      break;
    case "asset.card": {
      const index = next.assetCards.findIndex((card) => card.callId === event.payload.callId);
      if (index < 0) next.assetCards = [...next.assetCards, event.payload].slice(-100);
      else next.assetCards[index] = event.payload;
      const stepIndex = next.steps.findIndex((step) => step.id === event.payload.callId);
      const status = event.payload.status === "failed" ? "failed" as const : "succeeded" as const;
      const step = { id: event.payload.callId, title: event.payload.title, status };
      if (stepIndex < 0) next.steps = [...next.steps, step].slice(0, 100);
      else next.steps[stepIndex] = step;
      break;
    }
    case "verification.result":
      next.verification = { status: event.payload.status, summary: event.payload.summary.slice(0, 500) };
      break;
    case "preview.ready":
    case "run.cursor":
      break;
    case "run.finished":
      next.status = "succeeded";
      next.verification = next.verification.status === "pending" ? { status: "passed", summary: event.payload.summary } : next.verification;
      break;
    case "run.failed":
      next.status = "failed";
      next.verification = { status: "failed", summary: `La ejecución terminó con el código ${event.payload.errorCode}.` };
      break;
    case "run.cancelled":
      next.status = "cancelled";
      break;
  }
  return EditorProgressSchema.parse(next);
}

function isTerminalEvent(event: RunStreamEvent): boolean {
  return event.type === "run.finished" || event.type === "run.failed" || event.type === "run.cancelled";
}

function readEventFrame(frame: string): { id?: string; name?: string; data?: string } | undefined {
  let id: string | undefined;
  let name: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  return { id, name, data: data.join("\n") };
}

export function useRunEvents(projectId: string) {
  const [run, setRun] = useState<RunResponse | null>(null);
  const [progress, setProgress] = useState<EditorProgress>();
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [hydrating, setHydrating] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [previewRevision, setPreviewRevision] = useState(0);
  const [enabled, setEnabled] = useState<boolean | undefined>();
  const [latestMessageRequestId, setLatestMessageRequestId] = useState<string | null>(null);
  const [assistantSummary, setAssistantSummary] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/runs`, {
          cache: "no-store", credentials: "same-origin", signal: controller.signal,
        });
        if (!response.ok) throw new Error(runErrorMessage((await response.json().catch(() => ({})) as { error?: unknown }).error));
        const payload = await response.json() as { run?: unknown; enabled?: unknown; sourceMessageRequestId?: unknown };
        const latest = payload.run === null || payload.run === undefined ? null : RunResponseSchema.parse(payload.run);
        if (mounted) {
          setEnabled(typeof payload.enabled === "boolean" ? payload.enabled : undefined);
          setLatestMessageRequestId(typeof payload.sourceMessageRequestId === "string" ? payload.sourceMessageRequestId : null);
          setRun(latest);
          setProgress(latest ? emptyProgress(latest.status) : undefined);
          setAssistantSummary(null);
          setError("");
        }
      } catch (cause) {
        if (mounted && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "No se pudo recuperar la ejecución.");
      } finally {
        if (mounted) setHydrating(false);
      }
    })();
    return () => { mounted = false; controller.abort(); };
  }, [projectId]);

  useEffect(() => {
    const runId = run?.id;
    if (!runId) {
      setConnection("idle");
      return;
    }
    let stopped = false;
    let lastSequence = 0;
    let terminal = false;
    let attempts = 0;
    const lifecycle = new AbortController();
    setConnection("connecting");

    const apply = (frame: { id?: string; name?: string; data?: string }) => {
      if (!frame.data) return;
      const event = RunStreamEventSchema.parse(JSON.parse(frame.data));
      if (event.runId !== runId || frame.id !== String(event.sequence) || frame.name !== event.type) {
        throw new Error("El stream de progreso no coincide con la ejecución.");
      }
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      setProgress((current) => updateProgress(current ?? emptyProgress("queued"), event));
      setRun((current) => {
        if (!current || current.id !== runId) return current;
        if (event.type === "run.queued") return { ...current, status: "queued" };
        if (event.type === "run.status") return { ...current, status: event.payload.status };
        if (event.type === "run.finished") return { ...current, status: "succeeded", errorCode: null };
        if (event.type === "run.failed") return { ...current, status: "failed", errorCode: event.payload.errorCode };
        if (event.type === "run.cancelled") return { ...current, status: "cancelled", cancelRequested: false };
        if (event.type === "run.cancel_requested") return { ...current, cancelRequested: true };
        return current;
      });
      if (event.type === "preview.ready") setPreviewRevision(event.sequence);
      if (event.type === "run.finished") setAssistantSummary(event.payload.summary || "La ejecución terminó correctamente.");
      if (event.type === "run.failed") setAssistantSummary(runErrorMessage(event.payload.errorCode));
      if (event.type === "run.cancelled") setAssistantSummary("La ejecución se detuvo.");
      if (isTerminalEvent(event)) terminal = true;
    };

    const consume = async (response: Response) => {
      if (!response.body) throw new Error("El stream de progreso está vacío.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
          let separator = buffer.indexOf("\n\n");
          while (separator >= 0) {
            const frame = readEventFrame(buffer.slice(0, separator));
            buffer = buffer.slice(separator + 2);
            if (frame) apply(frame);
            separator = buffer.indexOf("\n\n");
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    };

    const connect = async () => {
      while (!stopped && !terminal) {
        const requestController = new AbortController();
        const abortRequest = () => requestController.abort();
        lifecycle.signal.addEventListener("abort", abortRequest, { once: true });
        try {
          const headers = new Headers({ accept: "text/event-stream" });
          if (lastSequence > 0) headers.set("last-event-id", String(lastSequence));
          const response = await fetch(`/api/runs/${runId}/events`, {
            headers,
            cache: "no-store",
            credentials: "same-origin",
            signal: requestController.signal,
          });
          if (!response.ok) {
            if (response.status === 404) {
              setError("La ejecución ya no está disponible.");
              setConnection("idle");
              return;
            }
            if (response.status === 401 || response.status === 503) {
              setError(response.status === 401 ? "La sesión caducó. Inicia sesión de nuevo." : "El stream no está disponible en este entorno.");
              setConnection("idle");
              return;
            }
            throw new Error("No se pudo conectar con el progreso del agente.");
          }
          setConnection("connected");
          setError("");
          await consume(response);
          attempts = 0;
          if (terminal) break;
        } catch {
          if (stopped || lifecycle.signal.aborted) break;
        } finally {
          lifecycle.signal.removeEventListener("abort", abortRequest);
        }
        if (!stopped && !terminal) {
          attempts += 1;
          setConnection("reconnecting");
          const delay = Math.min(10_000, 500 * (2 ** Math.min(attempts - 1, 5)));
          await delayOrAbort(delay, lifecycle.signal);
        }
      }
      if (!stopped) setConnection("idle");
    };

    void connect();
    return () => {
      stopped = true;
      lifecycle.abort();
    };
  }, [run?.id]); // A status update for this run must not restart its durable cursor.

  const enqueue = useCallback(async (messageRequestId: string, idempotencyKey: string) => {
    setWorking(true);
    setError("");
    try {
      const nextRun = await enqueueProjectRun(projectId, messageRequestId, idempotencyKey);
      setRun(nextRun);
      setProgress(emptyProgress(nextRun.status));
      setAssistantSummary(null);
      setPreviewRevision(0);
      return nextRun;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo encolar la ejecución.");
      throw cause;
    } finally {
      setWorking(false);
    }
  }, [projectId]);

  const cancel = useCallback(async () => {
    if (!run || !activeStatuses.has(run.status)) return;
    setWorking(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/runs/${run.id}`, {
        method: "DELETE", cache: "no-store", credentials: "same-origin",
      });
      if (!response.ok) throw new Error(runErrorMessage((await response.json().catch(() => ({})) as { error?: unknown }).error));
      const payload = await response.json() as { run?: unknown };
      const updated = RunResponseSchema.parse(payload.run);
      setRun(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo detener la ejecución.");
    } finally {
      setWorking(false);
    }
  }, [projectId, run]);

  return {
    run,
    progress,
    connection,
    hydrating,
    working,
    error,
    enabled,
    latestMessageRequestId,
    assistantSummary,
    previewRevision,
    active: Boolean(run && activeStatuses.has(run.status)),
    enqueue,
    cancel,
    clearError: () => setError(""),
  };
}

function delayOrAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
