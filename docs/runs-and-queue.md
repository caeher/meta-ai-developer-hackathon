# Runs, cola y presupuesto

Issue #11 separa la recepción de runs del request de Next. `POST /api/projects/[projectId]/runs` y `DELETE /api/projects/[projectId]/runs/[runId]` requieren autenticación propia, owner del proyecto y mismo origen en las mutaciones. `GET /api/projects/[projectId]/runs` recupera el último run y `GET` en la ruta individual devuelve únicamente el estado del run del mismo proyecto. `/api/runs/[runId]/events` transmite el progreso SSE privado. Las respuestas privadas usan `no-store`; no se aceptan owner IDs ni mensajes/prompts desde el payload de la cola.

## Flujo durable

1. La API valida el proyecto, bloquea la fila del usuario y del proyecto en PostgreSQL y verifica la clave idempotente.
2. En una única transacción crea el run `queued`, retiene el máximo de tokens configurado, crea el outbox y guarda `run.queued`. Una repetición devuelve el run anterior y no vuelve a retener presupuesto.
3. El worker reclama outbox con `FOR UPDATE SKIP LOCKED`, añade el job BullMQ a Redis con un `jobId` por run/generación y marca el outbox enviado. Si cae entre ambos pasos, reintenta el mismo ID; un reconciliador vuelve a publicar jobs que ya no están en Redis.
4. Antes de ejecutar, el worker busca run, proyecto y owner en PostgreSQL. Reclama un lease por proyecto que incrementa `fencingToken`; heartbeat, transiciones, consumo y resultado final exigen el token actual y lease vigente.
5. Al finalizar, una transacción guarda estado/evento, cargo medido idempotente y liberación del saldo restante. Reintentos de procesamiento se limitan a tres con backoff exponencial. Si vence el lease, reconciliación reencola con una generación nueva; resultados tardíos del worker previo fallan como stale.

Las cuotas diarias se computan en UTC sobre cargos netos del ledger más reservas abiertas. La fila de `users` serializa solicitudes concurrentes, así dos requests simultáneos no pueden reservar el mismo saldo. Una reserva que expire no se borra mientras su run siga activo; la retención se libera por cancelación/finalización o reconciliación del estado terminal.

## Estado de capacidad

`RUNS_ENABLED=false` por defecto. Mientras está apagada, POST devuelve `503 orchestrator_pending` y no crea una reserva. Cuando se activa, la API exige `messageRequestId` de un mensaje de usuario previamente guardado y `contributorConsent: true`; la transacción liga ese mensaje al run y guarda el consentimiento. El worker también exige consentimiento persistido, configuración Meta válida y `SANDBOX_DRIVER=rootless`. Los jobs Redis contienen únicamente `runId`, `idempotencyKey` y `generation`; nunca incluyen prompt, credenciales, tokens de sesión, URL o destino de runtime. El editor guarda el mensaje y encola el run con una clave estable; un intento nuevo puede asociarse al mismo mensaje con otra clave idempotente.

## Desarrollo y verificación

Con Node 24 y la infraestructura local configurada:

```sh
npm run infra:up -- --worker
npm run db:migrate
npm run dev:worker
npm run test:integration
npm run build:worker
```

`npm run test:integration` crea una base PostgreSQL efímera y bucket S3 de prueba, y usa el Redis local AOF. La suite de jobs cubre duplicados concurrentes, presupuesto y concurrencia, cancelación, publicación BullMQ, expiración de lease, fencing y caída/reinicio de un proceso worker hijo. Docker local no implica aislamiento de juegos; el worker no recibe el socket Docker, credenciales Meta, storage ni controlador de sandbox.

## Operación

- Configura `DATABASE_URL`, `REDIS_URL`, `USER_MAX_CONCURRENT_JOBS`, `RUN_MAX_TOKENS`, `USER_DAILY_TOKEN_LIMIT` y `USER_DAILY_IMAGE_LIMIT` para cada servicio; no copies `.env.local` al contenedor.
- Redis debe usar persistencia AOF y `maxmemory-policy=noeviction` en producción. PostgreSQL sigue siendo la fuente de verdad si Redis reinicia o pierde un job.
- `npm run infra:down` conserva los volúmenes locales. No borres los datos para resolver una cola atascada; inspecciona `run_outbox`, estado del run, `project_run_locks` y eventos antes de reconciliar.
- En el Compose local, detén web/worker y respalda PostgreSQL antes de aplicar rollback `0003_durable_runs_outbox_down.sql`. El rollback elimina estado nuevo de cola/leases.
