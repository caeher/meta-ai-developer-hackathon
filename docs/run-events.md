# Eventos SSE de ejecuciones (#17)

## Rutas

- `GET /api/projects/[projectId]/runs` comprueba owner y devuelve el último run, su `sourceMessageRequestId` y el estado de `RUNS_ENABLED`.
- `POST /api/projects/[projectId]/runs` recibe el `requestId` de un mensaje ya guardado, una clave idempotente y `contributorConsent: true`. La interfaz usa el mismo `requestId` como clave inicial; una acción explícita de reintento crea una clave nueva y mantiene el mensaje fuente.
- `DELETE /api/projects/[projectId]/runs/[runId]` solicita cancelación con autenticación propia, owner y protección de origen.
- `GET /api/runs/[runId]/events` transmite eventos versionados desde `runEvents`. La ruta valida la sesión y el owner al abrirla, revisa ownership en cada página y vuelve a verificar autenticación propia durante streams largos.

## Contrato y replay

Cada evento público de `packages/contracts/src/events.ts` contiene `version: 1`, `runId`, `sequence`, `createdAt`, `type` y un payload estricto. Los IDs SSE son las secuencias durables de PostgreSQL. `Last-Event-ID` debe ser un entero decimal no negativo y seguro; un cursor antiguo reproduce los eventos siguientes y un valor malformado devuelve `400`. Las páginas contienen hasta 50 filas. Si una fila interna no tiene una representación pública, se emite `run.cursor` vacío para avanzar el cursor sin filtrar sus datos.

El stream solo publica estados, plan aprobado, títulos de pasos, rutas de archivos escritas, resultados de verificación saneados, disponibilidad de preview y resultado final. La verificación solo informa estado; no se transmite `stdout`/`stderr`. No transmite argumentos de herramientas, contenido de archivos, resultados generales de herramientas, razonamiento, headers, reservas, uso, prompts ni trazas. Las URLs se eliminan de los textos proyectados y las rutas privadas o no válidas se omiten. `preview.ready` se persiste en el worker únicamente cuando `startDevServer` retorna después del health check del sandbox.

El handler conserva como máximo una página limitada en memoria y usa `highWaterMark: 1`; deja de leer PostgreSQL cuando el cliente no consume. Hace polling de eventos cada 750 ms y envía un heartbeat SSE cada 15 s. Al perder owner/proyecto, sesión o conexión, cierra sin revelar detalles. El navegador reanuda con `Last-Event-ID`, valida el schema recibido y aplica cada secuencia una sola vez. Tras una recarga recupera el run más reciente y reproduce el historial desde el inicio para reconstruir la vista.

La renovación automática de la preview solo escucha `preview.ready`; los fragmentos de texto y otras acciones no la recargan. El evento no incluye URL ni grant: el editor pide un grant privado nuevo por el endpoint existente.

## Operación y límites

Configura el proxy de despliegue para permitir `text/event-stream`, desactivar buffering y mantener un timeout inactivo mayor que el heartbeat de 15 s. `RUNS_ENABLED=false` continúa siendo el valor por defecto. Activarlo requiere Meta válido, controlador rootless y host Linux dedicado; este checkout no prueba las cuentas autenticación propia reales, el dominio wildcard/TLS ni el sandbox de producción.

Las pruebas offline cubren esquema/versionado, cursor inválido y antiguo, replay, payloads omitidos, redacción, backpressure, owner distinto, conexión del editor, reload y cancelación. Los recorridos con fixtures no sustituyen la comprobación autenticada con dos identidades autenticación propia ni la ejecución real en Linux.
