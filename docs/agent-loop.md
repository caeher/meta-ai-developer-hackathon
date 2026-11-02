# Orquestador de runs (#16)

## Flujo

1. La API valida sesión Clerk, origen y ownership. El cliente debe guardar primero el mensaje de usuario y luego enviar su `requestId` como `messageRequestId`, además de `contributorConsent: true`. Una transacción liga el mensaje al run, crea la reserva, outbox y evento inicial. Un mensaje no se puede asociar a otro run.
2. BullMQ transporta solo `runId`, `idempotencyKey` y `generation`. El worker reclama un lease de proyecto con fencing y carga el mensaje ligado desde PostgreSQL. Vuelve a validar el consentimiento guardado, el proyecto activo, el owner y el lease antes de leer el contenido o persistir un evento.
3. El worker bloquea patrones detectables de email, teléfono, tarjetas y credenciales. Selecciona skills por tarea con Phaser 3.90, presupuesto máximo de 8.000 tokens, y persiste el record de IDs/hashes sin el prompt ni cuerpos consultivos.
4. `MetaClient.plan` produce un JSON Schema estricto con objetivo, pasos, archivos relativos y verificaciones. El worker guarda `runs.plan`, `agent.meta_response_completed` y `agent.plan` antes de preparar el sandbox. Si el plan no valida, contiene una ruta fuera del workspace o excede el presupuesto, no se ejecutan herramientas.
5. El sandbox se resuelve en el controlador privado por proyecto. El agente recibe solo `read_file`, `write_file`, `list_files`, `install_dependencies`, `run_command`, `start_dev_server` y `read_logs`. Los schemas compartidos validan cada llamada; el worker espera `completed`, valida la respuesta completa y ejecuta una acción a la vez. Instalación es npm exacto y sin lifecycle scripts; comandos y archivos permanecen dentro del sandbox.
6. Un evento `agent.tool_started` se persiste con el fencing vigente antes de la llamada. `call_id` guarda hash de argumentos y salida saneada; el resultado completo se reutiliza si ese ID vuelve a aparecer con los mismos argumentos. Una operación iniciada sin resultado persistido queda ambigua y nunca se repite. El historial de acciones omite el contenido escrito y no conserva replay ni texto de razonamiento privado.
7. Antes de finalizar, el worker lee `package.json` y ejecuta `npm test` y `npm run build` si están configurados. Registra cada resultado y permite una reparación automática. Si no hay scripts, reporta verificación omitida; esto no indica que el juego esté listo para publicar.
8. Consumo usa `totalTokens` de cada respuesta Meta completada y se carga una sola vez en el ledger al finalizar. El run también respeta `PROJECT_MAX_RUN_STEPS` y `RUN_MAX_DURATION_MS`; cancelación y fencing detienen trabajo tardío.

## Activación

El modo permanece cerrado con `RUNS_ENABLED=false`. Activarlo requiere `META_API_KEY` y los modelos configurados, `SANDBOX_DRIVER=rootless`, `SANDBOX_CONTROLLER_URL` y `SANDBOX_CONTROLLER_TOKEN`, además de migrar PostgreSQL. El controlador real requiere el host Linux rootless dedicado validado por #12/#13. No se debe activar sobre Windows/Docker Desktop ni con `SANDBOX_DRIVER=disabled`.

La confirmación del servidor no reemplaza una explicación visible. El editor #17 informa que Contributor puede usar entradas para entrenamiento y pide confirmación de mayoría de edad antes de crear un run. Los detectores son heurísticos; no se deben enviar datos personales o confidenciales.

## Reintentos y límites

Los eventos de inicio impiden volver a llamar a Meta tras una caída sin respuesta reconciliable. Si el response ya se guardó pero el worker cae antes de completar las herramientas, el run falla como `agent_replay_unavailable`; las herramientas con resultado durable no se repiten. Un efecto marcado como iniciado pero sin resultado queda ambiguo y el worker falla cerrado sin repetirlo. Los cargos cuyo usage no llegó a persistirse durante una desconexión no pueden reconstruirse automáticamente porque Meta no documenta idempotencia; se conservan como ambigüedad y no se inicia otra llamada automática.

Las salidas de archivos y logs son datos no confiables, se limitan en tamaño y se redactan con detectores de secretos/PII. El modelo recibe instrucciones para ignorar instrucciones incluidas en ellos. Las herramientas no incluyen shell genérico, URL, host, puerto o acceso a infraestructura.

## Verificación local

```sh
npm test -- tests/unit/orchestrator.test.ts tests/unit/run-handlers.test.ts tests/meta-client.test.ts
npm run test:integration
npm run build:worker
npm run lint
npm run typecheck
```

Los tests de orquestación usan Meta y sandbox falsos. No sustituyen `npm run meta:smoke` opt-in ni las pruebas de aislamiento en el host Linux dedicado. La conexión del editor y SSE están documentadas en [eventos de runs](run-events.md); la plantilla Phaser corresponde a #18 y los assets de imagen a #19.
