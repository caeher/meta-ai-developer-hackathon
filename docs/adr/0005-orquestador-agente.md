# ADR 0005: orquestador de agente con plan previo

- Estado: aceptado.
- Fecha: 2026-11-02.
- Issue: #16.

## Decisiones

- El worker es el único coordinador del ciclo agéntico. Obtiene el mensaje por `ownerUserId`, proyecto y `runId` desde PostgreSQL; el job de Redis conserva únicamente IDs, idempotency key y generación.
- Para cada run la API liga un mensaje ya guardado y exige `contributorConsent=true`. La columna `runs.contributor_consent` es `false` por defecto; el worker vuelve a comprobarla antes de cargar el prompt. La UI debe explicar entrenamiento Contributor y exigir confirmación 18+ antes de llamar a la API (#17). La ruta sigue cerrada por `RUNS_ENABLED=false`.
- El prompt se filtra antes de enviarlo a Meta. Se bloquean patrones reconocibles de emails, teléfonos, tarjetas, claves y tokens; las herramientas redactan esos patrones en archivos y logs. Este filtro es heurístico y no vuelve apropiado Contributor para contenido personal o confidencial.
- `MetaClient.plan` debe devolver un plan Zod estricto con objetivo, pasos, rutas relativas y verificaciones. PostgreSQL guarda `runs.plan`, `agent.meta_response_completed` y `agent.plan` antes de preparar el sandbox o permitir herramientas.
- Skills cargadas son contexto consultivo. Herramientas disponibles son únicamente read/write/list, instalación npm exacta sin scripts, `npm test`/`npm run` tipado, servidor Vite fijo y logs. Las llamadas completas se validan con Zod; no se ejecutan deltas parciales. Las acciones se serializan y se registran por `call_id` con hash de argumentos y respuesta cacheada; un `call_id` repetido con argumentos distintos falla.
- Cada acción comienza con un evento escrito bajo lease/fencing vigente. El controlador vuelve a resolver proyecto y sandbox en PostgreSQL. La respuesta tardía de un worker antiguo no puede persistir eventos ni consumo.
- Se limita el run por pasos, tokens reportados por Meta y duración. El worker verifica `npm test` y `npm run build` si existen, permite un intento de reparación y registra las verificaciones. Sin scripts verificables el evento marca el chequeo como omitido; no promete que el juego sea jugable.
- Antes de cada `POST` de Meta se guarda un evento de inicio. Como Meta no documenta idempotencia, una caída después de iniciarlo no repite la llamada. Si no hay evento de finalización se falla cerrado; si el response se completó pero el proceso cayó antes de continuar, se registra el uso persistido conocido y se falla como no reanudable. No se finge reconciliación de cargos desconocidos.

## Migración y rollback

`0006_agent_contributor_consent.sql` añade la columna de consentimiento con default `false`, sin modificar filas previas de forma permisiva. El rollback `0006_agent_contributor_consent_down.sql` elimina esa columna; antes de usarlo en un entorno con runs recientes hay que detener web/worker y respaldar PostgreSQL.

## Límites y activación

`RUNS_ENABLED=false` permanece por defecto. Para activar en el Compose local se necesitan `META_API_KEY`, modelos admitidos y controlador privado con `SANDBOX_DRIVER=rootless` validado en esa configuración. La UI todavía no presenta consentimiento ni encola runs; la preview requiere además #14/#15 con `*.localhost` y TLS local cuando haga falta. Las pruebas offline no equivalen a smoke facturable ni a aislamiento Docker real.
