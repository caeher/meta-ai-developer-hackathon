# Plan en issues Markdown y sub-agentes

El agente principal puede descomponer un pedido en issues ejecutables y delegarlas, sin perder el lock de un solo escritor por proyecto.

## Tools nuevas

| Tool | Que hace | Facturable |
| --- | --- | --- |
| `generate_image` (existente) | Genera un asset con Meta y lo registra en `public/assets/generated/manifest.json` | Si (cuota de imagen) |
| `make_transparent` | Crea un PNG transparente NUEVO desde un `sourceAssetId` registrado del mismo owner/proyecto. Modos: `corner-flood` (flood-fill desde los bordes contra el color de esquina), `color-key` (color explicito) y `alpha-cleanup` (alpha semitransparente a 0/255). El original nunca se modifica y el resultado queda registrado en el manifest, listo para `pack_spritesheet` | No: es local y determinista (sharp) |
| `pack_spritesheet` (existente) | Empaca frames en un atlas Phaser 3.90 JSON Hash | No |
| `create_issue_plan` | Escribe `docs/issues/INDEX.md` y un `docs/issues/NN-slug.md` por issue con objetivo, tareas con checklist, dependencias y aceptacion. Devuelve el plan estructurado | No |
| `run_issue_agents` | Orquesta un sub-agente por issue | Solo las llamadas Meta de cada sub-agente |

Flujo de sprites recomendado: `generate_image` -> `make_transparent` (si hay fondo que quitar) -> `pack_spritesheet` -> `define_animation` -> `inspect_asset`.

## Orquestacion

`run_issue_agents` ordena las issues por dependencias, las ejecuta **secuencialmente** (un solo escritor por sandbox) y para cada issue:

1. Emite `agent.subagent_started` y marca `Estado: running` en el Markdown.
2. Lanza un loop Meta acotado (maximo 8 rondas) con las tools tipadas, **sin** `run_issue_agents` ni `create_issue_plan`: los sub-agentes no pueden anidar orquestacion.
3. Cada tool del sub-agente se persiste como cualquier tool del agente principal, con `callId` prefijado `sub-<issueId>-...`.
4. Al terminar emite `agent.subagent_completed` (`succeeded`/`failed`) y actualiza `Estado:` y `## Resultado` del `.md`. Si una dependencia fallo, los dependientes se marcan `failed` sin ejecutarse. Cancelacion, timeout o agotamiento de presupuesto abortan todo el run.

El agente principal recibe `{ results: [{ issueId, title, status, summary, toolCalls }] }`.

## Visibilidad en la web

Eventos durables nuevos: `agent.issue_plan`, `agent.subagent_started`, `agent.subagent_completed`. El proyector SSE los expone como `issue.plan` y `subagent.updated` (allowlist, sin prompts ni argumentos). El editor muestra dos pestanas nuevas junto a Plan/Pasos/Archivos/Verificacion:

- **Issues**: id, titulo, archivo Markdown, dependencias y estado (`pending`/`running`/`completed`/`failed`).
- **Agentes**: un sub-agente por issue con estado y resumen final.

`EditorProgress` gana `issues` y `subagents` con default `[]`, por lo que los replays antiguos siguen validando.

## Presupuesto

El catalogo de tools crece de 14 a 17 herramientas; cada llamada Meta estima el catalogo completo, por lo que el default de `RUN_MAX_TOKENS` sube de 16.000 a 32.000 (`packages/config`, `.env.example`). `RUNS_ENABLED=false` sigue siendo el default.
## Flujo por fases (sprites -> juego)

Ver [flujo agentico](agentic-flow.md): `create_issue_plan` y `run_issue_agents`
aceptan `kind` (`sprites` | `game` | `general`). Los planes de sprites van a
`docs/issues/sprites/` y se ejecutan con sub-agentes que solo tienen tools de
assets; el resumen de sprites (assetId/atlasId/frameNames) alimenta el plan de
juego en `docs/issues/game/`, ejecutado por sub-agentes de solo codigo. El
worker emite `agent.phase` (inventory, sprite-plan, sprites, game-plan, code,
verification) y etiqueta cada tool call con fase e issue para el chat agentico
del editor en `/projects/[projectId]`.
