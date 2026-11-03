# Evidencia del simulacro PostgreSQL + Silo (#26)

## Ejecucion

- Fecha: 2026-11-03 (hora local America/El_Salvador).
- Entorno: Docker Desktop, motor Linux 29.9.2; Docker Compose 5.6.1.
- Comando: `npm run backup:acceptance`.
- Resultado: correcto. Writers web/worker fueron detenidos por el flujo de backup y reiniciados al terminar.
- Dataset sintetico: un owner/proyecto, una version privada lista, un asset privado y dos objetos Silo (asset + snapshot).
- Validacion: restauracion a base/buckets vacios; join de ownership y metadata de proyecto/version/asset, bytes y SHA del asset/snapshot, y `decodeVersionSnapshot` de la version recuperada con dos archivos.
- Tiempos observados: backup 2.832 s; restore 1.287 s; ciclo total 4.642 s.
- Limpieza: bases y buckets temporales eliminados; Compose volvio a dejar Postgres, Redis, Silo, web y worker saludables.
## Health y metrica local

- `npm run infra:config`: valido.
- `npm run infra:up -- --web --worker`: servicios Postgres, Redis, Silo, Mailpit, web y worker saludables.
- `/api/health/livez`, `/api/health/readyz`, `/api/metrics` en web y `/livez`, `/readyz`, `/metrics` del worker devolvieron HTTP 200 desde Compose.
- Readiness devuelve 503 sin detalles internos cuando falla su dependencia, cubierto por `tests/unit/telemetry.test.ts`.
- No se configuro exportador OTLP durante la aceptacion.
- Los perfiles Compose `preview` y `publishing-origin` se construyeron y pasaron `/livez`, `/readyz` y `/metrics` con HTTP 200; sus contenedores se retiraron al terminar y los flags predeterminados siguen apagados.
- El smoke del gateway uso una clave publica RSA efimera generada en memoria; no se persistio ninguna clave.

## RPO/RTO medidos

El backup detiene los escritores de la aplicacion antes de capturar Postgres y Silo; la captura tiene RPO 0 respecto del limite consistente. El RPO operativo es el tiempo transcurrido desde la ultima copia correcta, porque no hay un scheduler configurado. La ejecucion midio un RTO de 1.287 s para el fixture pequeno. No extrapolar ese RTO a datasets de usuario: el tiempo escala con el dump y bytes S3.

La validacion recupera filas reales del esquema actual (`users`, `projects`, `versions`, `assets`) y abre/decodifica la version privada por el adaptador de snapshots. No ejecuta el editor contra una base temporal ni inicia preview jugable; `SANDBOX_DRIVER=disabled` y `PREVIEW_GATEWAY_ENABLED=false` permanecen como defaults. La preview jugable se prueba por separado dentro del alcance de sus issues.

No se almaceno ninguna clave ni valor de entorno en este informe. El ensayo usa una clave AES efimera generada en runtime y recursos desechables de Compose.

## Checks de entrega

- `npm test`: 303 pasaron y 55 skips opcionales/preexistentes.
- `npm run test:integration`: 54 pasaron y 1 skip opcional con PostgreSQL, Redis y Silo de Compose.
- `npm run lint` y `npm run typecheck`: correctos.
- `npm run build`, `npm run build:worker`, `npm run build:controller`, `npm run build:gateway`, `npm run build:publishing-origin` y `npm run build:game-template`: correctos.
- La suite, lint, typecheck y builds de cierre se ejecutaron en un worktree aislado sin archivo `.env.local`; no se configuro OTLP ni se uso una clave real de Meta.
- El build Phaser completo emitio solo el aviso existente de chunk mayor a 500 KiB; el build termino correctamente.
