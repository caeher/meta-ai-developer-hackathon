# Flujo agentico en /projects/[projectId]

El editor de un proyecto (`/projects/<id>`, componente `EditorShell`) es un chat
agentico: el cliente describe el juego y un orquestador ejecuta fases
obligatorias, delegando en sub-agentes especializados. Todo el progreso se
persiste como eventos durables y se proyecta por SSE al chat.

## Fases (evento durable `agent.phase`, proyeccion SSE `phase.updated`)

| Fase | Quien | Que hace |
| --- | --- | --- |
| `inventory` | Orquestador (sin Meta) | Compara la peticion con el GameSpec previo y el workspace (`inspectPriorGameSpec`, manifest de assets). El resumen dice si se reutiliza estado o se parte de la plantilla. |
| `sprite-plan` | Orquestador -> `create_issue_plan(kind="sprites")` | Escribe `docs/issues/sprites/INDEX.md` y un `NN-slug.md` por sprite/fondo/tileset/animacion, con prompt exacto de imagen, tamano/frames, transparencia, atlas y animaciones. Cada Markdown incluye la seccion "Como hacer los sprites". |
| `sprites` | Sub-agentes de sprites (`run_issue_agents(kind="sprites")`) | Solo tools de assets: `generate_image -> make_transparent -> inspect_asset -> pack_spritesheet -> define_animation` (+ `create_tileset`/`create_tilemap`). Devuelven assetId/atlasId/frameNames; no escriben codigo. |
| `game-plan` | Orquestador -> `create_issue_plan(kind="game")` | Escribe `docs/issues/game/*.md` detallando como implementar el juego consumiendo literalmente el resumen de sprites de la fase anterior. |
| `code` | Sub-agentes de codigo (`run_issue_agents(kind="game")`) | Solo tools de codigo (`read_file`, `write_file`, `list_files`, `run_command`, `start_dev_server`, `read_logs`, `inspect_asset`). No generan imagenes. |
| `verification` | Orquestador | Build/tests/interaccion en el sandbox antes de `preview.ready`. |

Orden forzado en el worker (`apps/worker/src/agent/orchestrator.ts`):
`run_issue_agents(kind="sprites")` sin un plan de sprites previo falla con
`agent_sprite_plan_required`, y `run_issue_agents(kind="game")` con un plan de
sprites existente pero sin sprites completados falla con
`agent_sprite_phase_incomplete`. El prompt del orquestador (`buildCodePrompt`)
exige el mismo orden; un trabajo trivial puede cerrar el codigo el propio
orquestador tras las fases de sprites/plan, dejandolo en el resumen.

Compatibilidad: `kind="general"` conserva el comportamiento anterior
(`docs/issues/*.md`, set completo de tools sin orquestacion) usado por planes
sin fases.

## Chat agentico (UI)

- Stepper "Flujo agentico" en el transcript con el estado de las 6 fases.
- Timeline de tool calls en el propio chat: cada `agent.tool_started` /
  `agent.action` / `agent.tool_failed` se proyecta como `step.started` /
  `step.completed` enriquecido con `toolName`, `phase` e `issueId`, y la web lo
  guarda en `EditorProgress.toolCalls` (tambien en la pestana **Actividad**).
- Pestanas **Issues** (Markdown por tipo sprites/game, dependencias, estado) y
  **Agentes** (sub-agente por issue, tipo, estado y resumen), ademas de Plan,
  Pasos, Archivos y Verificacion. Las tarjetas de assets generados siguen
  apareciendo intercaladas en el chat.
- `EditorProgress.phases/toolCalls/issues/subagents` tienen default `[]`, por
  lo que replays antiguos siguen validando.

## Archivos

- Contratos: `packages/contracts/src/agent-orchestration.ts` (`AgenticPhase`,
  `IssuePlanKind`, `ToolCallState`, `kind` en planes/run), `events.ts`,
  `editor.ts`.
- Worker: `apps/worker/src/agent/orchestrator.ts` (fases, guardas, prompts
  especializados, `phaseForToolCall`), `issue-plan.ts` (Markdown por tipo),
  `tools.ts` (`subagentToolNames`).
- Web: `apps/web/server/projects/run-events-handler.ts` (proyeccion),
  `apps/web/hooks/use-run-events.ts` (reduccion a fases/tool calls),
  `apps/web/components/editor/EditorShell.tsx` (chat agentico).
