# Operacion local: observabilidad y recuperacion (#26)

## Logs y correlacion

Los servicios emiten una linea JSON por evento. El logger aplica una lista cerrada de campos; elimina claves de prompt, contenido, credenciales, headers, cookies, sesiones y URLs. No se escriben prompts, argumentos de herramientas, IDs de usuario/proyecto ni URLs privadas. Los errores se representan con un codigo estable, no con el mensaje crudo del proveedor.

La web reemplaza cualquier `x-request-id` recibido por un UUID propio y devuelve ese ID en la respuesta. La cola conserva el `runId` durable; el worker lo pone en su contexto, lo propaga al controlador como `x-run-id` y lo incluye en eventos estructurados del run. El gateway enlaza la sesion de preview al run mas reciente cuando existe. Los IDs no se usan como labels de metricas.

`OTEL_EXPORTER_OTLP_ENDPOINT` es opcional. Si esta configurado, el logger envia lotes de logs sanitizados a `/v1/logs` por HTTP; el default no exporta datos fuera de Compose. El endpoint debe ser interno y no incluir usuario, contrasena, query ni fragmento. No se exportan prompts, headers ni payloads.

## Health, metricas y alertas

La web ofrece `GET /api/health/livez`, `GET /api/health/readyz` y `GET /api/metrics`. Readiness consulta PostgreSQL. Worker, controlador, gateway y origen de publicacion ofrecen `/livez`, `/readyz` y `/metrics` en el puerto interno `OBSERVABILITY_PORT` (9090 por defecto). Readiness comprueba las dependencias necesarias de cada proceso; los puertos internos no se publican en el host. Compose usa readiness para reinicio/estado del servicio.

Las metricas tienen nombres y labels de baja cardinalidad cerrados: solicitudes/duracion, resultados y tokens de Meta, cola y antiguedad, adquisicion/renovacion/perdida/expiracion de locks, runs, SSE, operaciones de sandbox, denegaciones del gateway, limpieza y espacio usado visible al worker. Los importes de Meta son estimaciones solo cuando el operador fija las variables de precio; no sustituyen la factura del proveedor. Los labels no contienen IDs.

El worker evalua las condiciones en su ciclo de reconciliacion de un segundo y usa una ventana movil de cinco minutos para errores del proveedor y fallos de limpieza. Registra eventos `alert.fired` y `alert.resolved` para estas condiciones:

- Cola esperando 15 minutos o mas.
- Filesystem visible dentro del worker con 85% o mas de uso.
- Errores/ambiguos del proveedor >=20% cuando hay al menos cinco solicitudes en la ventana.
- Al menos un fallo de limpieza en la ventana.

Estas alertas locales se consultan con `docker compose -f infra/compose.yml --env-file infra/.env logs worker`. No hay paging externo por defecto. Los contenedores usan rotacion json-file de 10 MiB y cinco archivos. La metrica de disco describe el filesystem visible al contenedor; no certifica el espacio libre del disco de Docker Desktop.

Comprobacion manual sin mostrar configuracion:

```sh
npm run infra:config
docker compose -f infra/compose.yml --env-file infra/.env ps
curl http://localhost:3000/api/health/livez
curl http://localhost:3000/api/health/readyz
curl http://localhost:3000/api/metrics
```

Los endpoints de los servicios internos se consultan desde su red Compose, por ejemplo `docker compose ... exec worker node -e ...` no es necesario para el flujo normal; `docker compose ps` y los healthchecks son la comprobacion primaria. No publiques 9090 en un host compartido.

## Backup y restauracion

`npm run backup:create` crea una copia coherente de la base PostgreSQL configurada y de los buckets privado y publico de Silo. Detiene web, worker, controlador y origen de publicacion si estan en ejecucion; espera al worker y lo detiene antes del snapshot. Preview gateway permanece activo y solo consulta PostgreSQL; Redis no forma parte del backup. Al terminar, vuelve a iniciar los servicios que estaban activos, incluso si falla el backup. El backup contiene un `pg_dump` custom y todos los objetos S3, cifra cada archivo con AES-256-GCM y guarda la clave activa como ID, nunca como valor, en el formato publico. La carpeta por defecto es `./backups/encrypted`, ignorada por Git; guarda una copia adicional en almacenamiento cifrado administrado por el operador.

Configura `BACKUP_KEY_ID` y `BACKUP_ENCRYPTION_KEYS` en `infra/.env` con un keyring JSON cuyos valores son claves Base64 de 32 bytes. Los placeholders de `infra/env.example` no permiten cifrar: sustituye los valores localmente y protege el archivo. Conserva cada clave mientras existan backups cifrados con su ID. El proceso de rotacion es aditivo: anade la nueva clave sin borrar las antiguas, cambia `BACKUP_KEY_ID`, crea y restaura una copia nueva de prueba, y solo retira la clave anterior despues de vencer la retencion y verificar una copia independiente. No guardes las claves en Git, issues, chat ni en la misma carpeta de backups.

Restaurar nunca sobrescribe una base o bucket existentes. Elige nombres nuevos y vacios; el script se cierra si los targets existen y revierte los recursos creados por la operacion fallida:

```sh
npm run backup:restore -- --backup-dir .\backups\forja-backup-<id> --database-name forja_restore --bucket-private forja-restore-private --bucket-public forja-restore-public
```

El restore local valida autenticidad GCM y checksum, crea la base/buckets, importa el dump y copia objetos. Despues, verifica manualmente la aplicacion contra los targets restaurados antes de cualquier cambio de trafico. No ejecutes `infra:down --volumes` como procedimiento de rollback; es un reset destructivo de toda la persistencia local.

Para el simulacro reproducible con recursos desechables de Compose:

```sh
npm run infra:up
npm run backup:acceptance
```

El simulacro crea y borra bases y buckets con sufijos aleatorios, inserta owner/proyecto/version/asset sinteticos del esquema actual, detiene/reinicia escritores Compose, cifra un backup, restaura a destinos vacios y valida ownership, hashes, bytes y decodificacion de snapshot privado. No usa datos de usuarios ni claves fijas de prueba. Tiempos y limites medidos: [informe](./backup-restore-report.md).

Para rotar claves preview, conserva la clave publica anterior al menos durante el TTL de grants mas margen de reloj mientras web y gateway cambian juntos al nuevo key ID/private key; despues elimina la publica antigua. La rotacion de clave de backup conserva todas las claves previas mientras exista cualquier backup cifrado con su ID. Los pasos operativos estan en [runbook de backup/restore](./runbooks/backup-restore.md); el diagnostico y rollback, en [runbook de incidentes](./runbooks/incident-response.md).

## Respuesta y rollback

1. Comprueba `livez`, `readyz`, `docker compose ps` y los ultimos eventos estructurados. No incluyas `.env` ni el cuerpo de una solicitud en un reporte.
2. Para una cola atascada, confirma que DB/Redis estan listos, observa antiguedad y worker logs; recupera el worker con `docker compose ... restart worker` solo despues de confirmar que no hay un backup deteniendo el servicio.
3. Para saturacion de disco, identifica volumenes Compose y backups locales; no borres volumenes de DB/Silo. Expande/limpia solo artefactos locales identificados y conservando la retencion.
4. Para una version defectuosa, deshabilita el flag del componente afectado y vuelve al digest de imagen/configuracion previamente aceptado. Mantiene DB/S3; las migraciones siguen la guia aditiva con reversa explicita.
5. Si una restauracion falla, conserva los backups cifrados y sus claves. Los scripts limpian los targets que crearon; si el proceso fue terminado a la fuerza, inspecciona `docker compose ps` y elimina unicamente los targets temporales vacios que identifiques.

## Estado y limites

El simulacro informa su duracion medida en `docs/backup-restore-report.md`. Este entorno valida PostgreSQL y Silo en Docker Desktop local. No incluye exportacion automatica fuera del equipo ni notificacion externa: el operador conserva una copia independiente y decide su destino. No se usa VPS, DNS publico, host Linux remoto ni TLS wildcard real.
