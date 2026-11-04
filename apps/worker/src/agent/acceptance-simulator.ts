import { randomUUID } from "node:crypto";
import type { MetaCodeEvent, MetaConversationItem, MetaPlanResult, MetaUsage } from "@meta-game/contracts";
import type { MetaClient, MetaCodeRequest } from "@meta-game/meta";

const MODEL = "local-acceptance-simulator";
const PROJECT_SPEC_CALL_ID = "local-acceptance-project-spec";
const ZERO_USAGE: MetaUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
type AcceptanceSimulatorMeta = Pick<MetaClient, "plan" | "streamCode" | "generateImage" | "editImage">;

/** Deterministic acceptance-only adapter. It never performs provider or image requests. */
export function createAcceptanceSimulatorMeta(): AcceptanceSimulatorMeta {
  return {
    async plan(prompt): Promise<MetaPlanResult> {
      const userRequest = extractUserRequest(prompt);
      assertDiggingRequest(userRequest);
      return {
        model: MODEL,
        responseId: `local-plan-${randomUUID()}`,
        plan: {
          summary: "Crear un juego local de excavación con tres niveles y controles accesibles.",
          objective: "Excavar, recoger gemas, esquivar rocas y llegar a la salida en una preview Phaser jugable.",
          steps: [
            {
              id: "gameplay",
              title: "Preparar el juego de excavación",
              description: "Configurar la plantilla Phaser para el minero, las gemas, las rocas y la salida.",
              expectedFiles: ["src/game/project-spec.json"],
              verifications: ["La plantilla selecciona el modo de excavación y muestra el título del juego."],
            },
            {
              id: "playtest",
              title: "Verificar y abrir la preview",
              description: "Ejecutar las verificaciones de la plantilla y servir la preview privada del sandbox.",
              expectedFiles: ["src/game/DiggingScene.ts", "src/game/digging.ts"],
              verifications: ["Las pruebas, el build y la interacción de teclado de Chromium pasan."],
            },
          ],
        },
        usage: ZERO_USAGE,
      };
    },

    async *streamCode(request: MetaCodeRequest): AsyncGenerator<MetaCodeEvent> {
      const userRequest = extractUserRequest(request.prompt);
      assertDiggingRequest(userRequest);
      const context = request.context ?? [];
      const hasSpecWriteResult = context.some((item) => item.kind === "tool_result" && item.callId === PROJECT_SPEC_CALL_ID);
      if (hasSpecWriteResult) {
        const replay: MetaConversationItem[] = [
          ...context,
          { kind: "message", role: "assistant", text: "Juego de excavación preparado localmente; verificaciones y preview gestionadas por el sandbox de aceptación." },
        ];
        yield { type: "completed", responseId: `local-code-${randomUUID()}`, model: MODEL, replay, usage: ZERO_USAGE };
        return;
      }

      const arguments_ = { path: "src/game/project-spec.json", content: localDiggingProjectSpec(userRequest) };
      yield { type: "tool_call", callId: PROJECT_SPEC_CALL_ID, name: "write_file", arguments: arguments_ };
      const replay: MetaConversationItem[] = [
        ...context,
        { kind: "tool_call", callId: PROJECT_SPEC_CALL_ID, name: "write_file", arguments: arguments_ },
      ];
      yield { type: "completed", responseId: `local-code-${randomUUID()}`, model: MODEL, replay, usage: ZERO_USAGE };
    },

    async generateImage(): Promise<never> {
      throw new Error("acceptance_simulator_image_generation_blocked");
    },

    async editImage(): Promise<never> {
      throw new Error("acceptance_simulator_image_editing_blocked");
    },
  };
}

function extractUserRequest(prompt: string): string {
  const match = /User request:\n([\s\S]*?)\n\nApproved plan:/.exec(prompt);
  return (match?.[1] ?? prompt).trim();
}

function assertDiggingRequest(prompt: string): void {
  if (!/boulder.?dash|digging|excava(?:ci[oó]n|r)?|minero|gemas?|rocas?\s+que\s+caen/i.test(prompt)) {
    throw new Error("acceptance_simulator_only_supports_digging_demo");
  }
}

function localDiggingProjectSpec(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0] ?? "";
  const requestedName = firstLine.replace(/^(?:crea|create|haz|make)\s+/i, "").split(/[,.:!?]/, 1)[0]?.trim();
  const title = (requestedName || "Excavación de esmeraldas").slice(0, 48);
  const movement = /\bwasd\b/i.test(prompt) ? "wasd" : "arrows";
  const movementLabel = movement === "wasd" ? "WASD" : "Flechas";
  return `${JSON.stringify({
    schemaVersion: 1,
    genre: "puzzle",
    intent: "create",
    objective: "Excava tres niveles, recoge seis esmeraldas por nivel, esquiva rocas que caen y abre la salida.",
    changes: ["level", "controls", "mechanics"],
    controls: { movement, action: "space", touch: true },
    mode: "digging",
    title,
    actionLabel: "Abrir salida",
    controlHelp: `${movementLabel} para excavar · recoge seis esmeraldas · llega a la salida · botones táctiles visibles`,
  }, null, 2)}\n`;
}
