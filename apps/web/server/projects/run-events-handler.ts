import {
  AgentRunEventSchema,
  RunStreamEventSchema,
  type RunStreamEvent,
  type RunStatus,
} from "@meta-game/contracts";
import type { VerifiedIdentityContext } from "@meta-game/db";
import { OwnedResourceNotFoundError } from "@meta-game/db";
import { apiErrorResponse } from "../auth/http";
import { adjustSseConnections, recordSseEvent } from "../observability";

interface StoredRunEvent {
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

interface RunEventsRepository {
  get(identity: VerifiedIdentityContext, runId: string): Promise<{ id: string; status: string } | undefined>;
  listEvents(identity: VerifiedIdentityContext, runId: string, input: { afterSequence: number; limit: number }): Promise<StoredRunEvent[]>;
}

type StreamRunStatus = Extract<RunStatus, "queued" | "planning" | "running" | "verifying">;
type RunEventRow = StoredRunEvent;
type Projected = { event: RunStreamEvent; terminal: boolean };

const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
const pollIntervalMs = 750;
const heartbeatIntervalMs = 15_000;
const sessionCheckIntervalMs = 30_000;
const pageSize = 50;
const sseHeaders = {
  "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
  "content-type": "text/event-stream; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
  "vary": "Cookie",
};

export function parseLastEventId(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value)) throw new TypeError("Invalid Last-Event-ID");
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) throw new TypeError("Invalid Last-Event-ID");
  return sequence;
}

export function createRunEventsHandler(options: {
  identity: VerifiedIdentityContext;
  runs: RunEventsRepository;
  validateSession?: () => Promise<void>;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? abortableWait;

  return async function GET(request: Request, context: { params: Promise<{ runId: string }> }): Promise<Response> {
    try {
      const { runId } = await context.params;
      const afterSequence = parseLastEventId(request.headers.get("last-event-id"));
      const run = await options.runs.get(options.identity, runId);
      if (!run) throw new OwnedResourceNotFoundError();
      const stream = createEventStream({
        identity: options.identity,
        runs: options.runs,
        runId,
        afterSequence,
        request,
        onConnectionChange: adjustSseConnections,
        onEvent: recordSseEvent,
        now,
        wait,
        validateSession: options.validateSession,
      });
      return new Response(stream, { headers: sseHeaders });
    } catch (error) {
      return apiErrorResponse(error);
    }
  };
}

function createEventStream(input: {
  identity: VerifiedIdentityContext;
  runs: RunEventsRepository;
  runId: string;
  afterSequence: number;
  request: Request;
  onConnectionChange(change: 1 | -1): void;
  onEvent(type: string): void;
  now: () => number;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  validateSession?: () => Promise<void>;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  let closed = false;
  let cursor = input.afterSequence;
  let lastHeartbeatAt = input.now();
  let lastSessionCheckAt = 0;
  let pending: Projected[] = [];
  const requestSignal = input.request.signal;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.onConnectionChange(1);
      const close = () => {
        if (closed) return;
        closed = true;
        input.onConnectionChange(-1);
        requestSignal.removeEventListener("abort", abort);
        try { controller.close(); } catch { /* The client may already have cancelled the stream. */ }
      };
      const abort = () => {
        cancelled = true;
        close();
      };
      requestSignal.addEventListener("abort", abort, { once: true });

      const pump = async () => {
        try {
          while (!cancelled && !closed) {
            if (requestSignal.aborted) {
              abort();
              return;
            }
            const desiredSize = controller.desiredSize;
            if (desiredSize === null) {
              close();
              return;
            }
            if (desiredSize <= 0) {
              await input.wait(50, requestSignal);
              continue;
            }

            if (input.validateSession && input.now() - lastSessionCheckAt >= sessionCheckIntervalMs) {
              await input.validateSession();
              lastSessionCheckAt = input.now();
            }

            if (pending.length === 0) {
              const stored = await input.runs.listEvents(input.identity, input.runId, { afterSequence: cursor, limit: pageSize });
              pending = stored
                .filter((event) => event.sequence > cursor)
                .map((event) => projectStoredEvent(input.runId, event));
            }

            while (pending.length > 0 && (controller.desiredSize ?? 0) > 0) {
              const projected = pending.shift();
              if (!projected) break;
              cursor = projected.event.sequence;
              input.onEvent(projected.event.type);
              controller.enqueue(encodeEvent(projected.event, encoder));
              lastHeartbeatAt = input.now();
              if (projected.terminal) {
                close();
                return;
              }
            }
            if (pending.length > 0) continue;

            const latestRun = await input.runs.get(input.identity, input.runId);
            if (!latestRun) {
              close();
              return;
            }
            if (terminalStatuses.has(latestRun.status)) {
              close();
              return;
            }
            if (input.now() - lastHeartbeatAt >= heartbeatIntervalMs && (controller.desiredSize ?? 0) > 0) {
              controller.enqueue(encoder.encode(": keep-alive\n\n"));
              lastHeartbeatAt = input.now();
            }
            await input.wait(pollIntervalMs, requestSignal);
          }
        } catch {
          // Ownership loss, session revocation and database errors close the stream without exposing internals.
          close();
        }
      };

      void pump();
    },
    cancel() {
      if (!closed) input.onConnectionChange(-1);
      cancelled = true;
      closed = true;
    },
  }, { highWaterMark: 1 });
}

function projectStoredEvent(runId: string, row: RunEventRow): Projected {
  const envelope = { version: 1 as const, runId, sequence: row.sequence, createdAt: row.createdAt.toISOString() };
  const payload = isRecord(row.payload) ? row.payload : {};
  let candidate: Omit<RunStreamEvent, "sequence" | "createdAt" | "runId" | "version"> | undefined;
  let terminal = false;

  if (row.type === "run.queued") candidate = { type: "run.queued", payload: { status: "queued" } };
  else if (row.type === "run.claimed" || row.type === "run.planning") candidate = { type: "run.status", payload: { status: "planning" } };
  else if (row.type === "run.running" || row.type === "run.verifying") {
    candidate = { type: "run.status", payload: { status: row.type.slice(4) as StreamRunStatus } };
  } else if (row.type === "run.requeued" || row.type === "run.retry_scheduled") {
    candidate = { type: "run.status", payload: { status: "queued" } };
  } else if (row.type === "run.cancel_requested") candidate = { type: "run.cancel_requested", payload: {} };
  else if (row.type === "run.succeeded") {
    candidate = { type: "run.finished", payload: { summary: safeText(typeof payload.summary === "string" ? payload.summary : "La ejecución terminó correctamente.", 600) } };
    terminal = true;
  } else if (row.type === "run.failed") {
    candidate = { type: "run.failed", payload: { errorCode: safeErrorCode(payload.errorCode) } };
    terminal = true;
  } else if (row.type === "run.cancelled") {
    candidate = { type: "run.cancelled", payload: {} };
    terminal = true;
  } else if (row.type === "agent.plan") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.plan") {
      candidate = {
        type: "plan.created",
        payload: {
          summary: safeText(parsed.data.payload.plan.summary, 600) || "Plan de trabajo",
          objective: safeText(parsed.data.payload.plan.objective, 300) || "Completar el objetivo del proyecto",
          steps: parsed.data.payload.plan.steps.map(({ id, title }) => ({
            id,
            title: safeText(title, 120) || "Paso de trabajo",
          })),
        },
      };
    }
  } else if (row.type === "agent.tool_started") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.tool_started") {
      candidate = {
        type: "step.started",
        payload: { stepId: parsed.data.payload.callId, title: toolTitle(parsed.data.payload.toolName), toolName: parsed.data.payload.toolName, ...(parsed.data.payload.phase ? { phase: parsed.data.payload.phase } : {}), ...(parsed.data.payload.issueId ? { issueId: parsed.data.payload.issueId } : {}) },
      };
    }
  } else if (row.type === "agent.action") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.action") {
      candidate = {
        type: "step.completed",
        payload: {
          stepId: parsed.data.payload.callId,
          title: safeText(parsed.data.payload.summary, 240) || toolTitle(parsed.data.payload.toolName),
          status: "succeeded",
          toolName: parsed.data.payload.toolName,
          ...(parsed.data.payload.phase ? { phase: parsed.data.payload.phase } : {}),
          ...(parsed.data.payload.issueId ? { issueId: parsed.data.payload.issueId } : {}),
        },
      };
    }
  } else if (row.type === "agent.tool_completed") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.tool_completed" &&
        ["write_file", "generate_image", "create_issue_plan"].includes(parsed.data.payload.toolName)) {
      const result = parseJsonRecord(parsed.data.payload.result);
      const path = safeWorkspacePath(result?.path);
      if (path) {
        const bytesValue = result?.bytesWritten;
        const bytesWritten = typeof bytesValue === "number" && Number.isSafeInteger(bytesValue) && bytesValue >= 0
          ? bytesValue
          : undefined;
        candidate = { type: "file.changed", payload: { path, ...(bytesWritten === undefined ? {} : { bytesWritten }) } };
      }
    }
  } else if (row.type === "agent.asset_result") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.asset_result") {
      candidate = { type: "asset.card", payload: parsed.data.payload.card };
    }
  } else if (row.type === "agent.tool_failed") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.tool_failed") {
      if (parsed.data.payload.assetCard) {
        candidate = { type: "asset.card", payload: parsed.data.payload.assetCard };
      } else {
        candidate = {
          type: "step.completed",
          payload: {
            stepId: parsed.data.payload.callId,
            title: toolTitle(parsed.data.payload.toolName),
            status: "failed",
            toolName: parsed.data.payload.toolName,
            ...(parsed.data.payload.phase ? { phase: parsed.data.payload.phase } : {}),
            ...(parsed.data.payload.issueId ? { issueId: parsed.data.payload.issueId } : {}),
          },
        };
      }
    }
  } else if (row.type === "agent.verification") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.verification") {
      candidate = {
        type: "verification.result",
        payload: {
          check: safeText(parsed.data.payload.check, 120),
          status: parsed.data.payload.status,
          ...(parsed.data.payload.exitCode === undefined ? {} : { exitCode: parsed.data.payload.exitCode }),
          summary: safeVerificationSummary(parsed.data.payload.summary, parsed.data.payload.status),
        },
      };
    }
  } else if (row.type === "agent.issue_plan") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.issue_plan") {
      candidate = { type: "issue.plan", payload: { planId: parsed.data.payload.planId, title: safeText(parsed.data.payload.title, 120) || "Plan en issues", kind: parsed.data.payload.kind ?? "general", issues: parsed.data.payload.issues } };
    }
  } else if (row.type === "agent.subagent_started") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.subagent_started") {
      candidate = { type: "subagent.updated", payload: { issueId: parsed.data.payload.issueId, title: safeText(parsed.data.payload.title, 160) || "Issue", status: "running", kind: parsed.data.payload.kind ?? "general", ...(parsed.data.payload.phase ? { phase: parsed.data.payload.phase } : {}) } };
    }
  } else if (row.type === "agent.subagent_completed") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.subagent_completed") {
      candidate = { type: "subagent.updated", payload: { issueId: parsed.data.payload.issueId, title: safeText(parsed.data.payload.title, 160) || "Issue", status: parsed.data.payload.status, kind: parsed.data.payload.kind ?? "general", ...(parsed.data.payload.phase ? { phase: parsed.data.payload.phase } : {}), summary: safeText(parsed.data.payload.summary, 600) } };
    }
  } else if (row.type === "agent.phase") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.phase") {
      candidate = { type: "phase.updated", payload: { phase: parsed.data.payload.phase, status: parsed.data.payload.status === "started" ? "running" : parsed.data.payload.status, summary: safeText(parsed.data.payload.summary, 600) } };
    }
  } else if (row.type === "agent.preview_ready") {
    const parsed = AgentRunEventSchema.safeParse({ type: row.type, payload });
    if (parsed.success && parsed.data.type === "agent.preview_ready") {
      candidate = { type: "preview.ready", payload: { state: "ready" } };
    }
  }

  const event = RunStreamEventSchema.parse({ ...envelope, ...(candidate ?? { type: "run.cursor", payload: {} }) });
  return { event, terminal };
}

function encodeEvent(event: RunStreamEvent, encoder: TextEncoder): Uint8Array {
  return encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function toolTitle(toolName: string): string {
  const titles: Record<string, string> = {
    prepare_sandbox: "Preparar el espacio de trabajo",
    read_file: "Leer un archivo",
    write_file: "Escribir un archivo",
    generate_image: "Generar y validar un asset de juego",
    make_transparent: "Hacer transparente un asset",
    create_issue_plan: "Crear el plan en issues Markdown",
    run_issue_agents: "Orquestar sub-agentes por issue",
    edit_sprite: "Editar un sprite",
    inspect_asset: "Inspeccionar un asset",
    create_tileset: "Crear un tileset",
    create_tilemap: "Crear un tilemap",
    pack_spritesheet: "Empaquetar frames en un atlas",
    define_animation: "Definir una animación",
    list_files: "Revisar archivos",
    install_dependencies: "Instalar dependencias aprobadas",
    run_command: "Ejecutar una verificación",
    start_dev_server: "Iniciar el servidor de preview",
    read_logs: "Revisar logs acotados",
  };
  return titles[toolName] ?? "Acción del agente";
}

function safeWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256 || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const parts = value.split("/");
  const sensitivePath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|id_rsa(?:\.[^/]*)?|authorized_keys|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|service[-_]?account(?:\.[^/]*)?|kubeconfig|[^/]+\.(?:pem|key|p12|pfx))(?:$|\/)/i;
  if (sensitivePath.test(value) || parts.some((part) => !part || part === "." || part === ".." || /^(?:\.git|node_modules)$/i.test(part))) return undefined;
  return value;
}

function safeText(value: string, limit: number): string {
  const stripped = value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/```[\s\S]*?```/g, "[contenido omitido]")
    .replace(/(?:\b[a-z][a-z0-9+.-]*:\/\/|\bmailto:|\bwww\.)[^\s<>"'`]+/gi, "[URL omitida]")
    .replace(/\b(?:Bearer\s+|api[_ -]?key\s*[:=]\s*|password\s*[:=]\s*|secret\s*[:=]\s*)[A-Za-z0-9._~+/-]{12,}={0,2}/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, "[REDACTED]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[REDACTED]")
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+\S+/.test(line) && !/^\s*(?:Node\.js|Error:)/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, limit);
}

function safeVerificationSummary(_value: string, status: "passed" | "failed" | "skipped"): string {
  return status === "passed" ? "La verificación terminó correctamente." : status === "failed" ? "La verificación encontró un error." : "La verificación se omitió.";
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(value) ? value : "run_failed";
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
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
