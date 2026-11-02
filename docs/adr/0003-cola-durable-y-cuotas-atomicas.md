# ADR 0003: cola durable, leases de proyecto y cuotas atómicas

- Estado: aceptado.
- Fecha: 2026-11-02.
- Issue: #11.

## Decisiones

- PostgreSQL es la fuente de verdad del run y de su reserva. `runs`, `usage_reservations`, `run_events` y `run_outbox` se escriben en una transacción. La publicación posterior en BullMQ/Redis usa un `jobId` estable por `(runId, generation)`, por lo que reintentar la entrega después de un fallo entre Redis y Postgres no crea una segunda reserva.
- El worker reclama filas del outbox con `FOR UPDATE SKIP LOCKED`, lease corto y token de reclamación. Redelivery incrementa `generation`; el worker valida run, idempotency key, owner/proyecto derivados de Postgres y generación antes de adquirir trabajo. Los payloads Redis contienen solo `runId`, `idempotencyKey` y `generation`.
- `project_run_locks` conserva un contador monotónico de fencing. Claim, heartbeat, transición y finalización requieren el token vigente y un lease no vencido. Un worker antiguo puede seguir vivo después de una partición, pero no puede guardar estados, eventos ni consumo una vez vencido/reemplazado su fencing token.
- La reserva serializa por fila de usuario en PostgreSQL. Los runs activos, retenciones abiertas y cargos netos UTC del día se comparan antes de crear el run; una clave repetida devuelve el run original sin reservar de nuevo. Los errores de cuota son 429 y un run distinto para un proyecto ocupado es 409.
- La reserva queda activa durante retries/reconciliación. Cancelar en cola libera inmediatamente; cancelar un run activo registra una petición, que el worker observa con heartbeat y debe atender mediante `AbortSignal`. Consumo real se registra con una clave de ledger idempotente; el saldo no usado se libera al finalizar.
- BullMQ reintenta fallos transitorios tres veces con backoff exponencial. Una excepción terminal deja `failed` y un `errorCode` acotado. Al expirar un lease, el reconciliador reencola el run con una generación nueva; los resultados con fencing viejo se rechazan.
- La API `POST /api/projects/[projectId]/runs` verifica Clerk, owner y origen. `RUNS_ENABLED=false` por defecto devuelve `503 orchestrator_pending`. Con la bandera activa exige `messageRequestId` de un mensaje user guardado y `contributorConsent: true`; #16 persiste el vínculo y consentimiento antes de encolar. El handler de éxito inyectable solo se usa en pruebas.
- Redis usa AOF en Compose y `noeviction` debe mantenerse en producción. El outbox permite recuperar el envío cuando Redis pierde un job; Redis no reemplaza el ledger o el estado durable de PostgreSQL.

## Migración y rollback

`0003_durable_runs_outbox.sql` es aditiva: añade estado de cancelación, vínculo de reserva con run, locks y outbox. Una base de prueba puede revertirla con `0003_durable_runs_outbox_down.sql` antes de volver a migrar. En instalaciones con runs nuevos, hacer respaldo y detener web/worker antes de revertir; el rollback elimina los leases/outbox y la relación run-reserva añadida.

## Límites

- #16 conecta Meta, skills y herramientas del sandbox con plan previo y eventos durables. La bandera permanece apagada mientras no se validen el consentimiento visible del chat (#17), la clave Meta y el host Linux rootless dedicado.
- El fencing bloquea escrituras tardías en PostgreSQL. No vuelve idempotentes solicitudes externas cuyo proveedor no ofrezca idempotency keys; el futuro orquestador debe persistir antes de cada efecto y reconciliar resultados ambiguos.
- La integración actual prueba DB/Redis locales y expiración de lease; Clerk real continúa sujeto a las credenciales y cuentas de prueba existentes en #4.
