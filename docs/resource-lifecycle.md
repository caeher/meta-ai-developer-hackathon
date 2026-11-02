# Cuotas y ciclo de vida de recursos

## Límites de uso

La aplicación y el worker leen cuotas de configuración por servicio. Los valores de desarrollo versionados en `.env.example` son 50 proyectos activos, 1.024 MiB de storage privado, 1 run simultáneo, 16.000 tokens por ejecución y 10 imágenes al día. `USER_MAX_PROJECTS`, `USER_MAX_STORAGE_MB`, `USER_MAX_CONCURRENT_JOBS`, `RUN_MAX_TOKENS`, `RUN_MAX_DURATION_MS`, `USER_DAILY_TOKEN_LIMIT` y `USER_DAILY_IMAGE_LIMIT` se pueden ajustar por entorno.

PostgreSQL serializa las altas de proyectos, reservas de storage y enqueues del mismo usuario mediante el lock de su fila. Assets pendientes, snapshots de versiones, snapshots de suspensión y reservas de bytes forman parte de la cuota de storage. Si el límite se agota, la API responde `429 usage_limit_<tipo>` y la UI de `/projects` muestra uso, reservas y motivo. El resumen se actualiza al recuperar foco y cada 30 segundos. El límite de tiempo se aplica por run y se muestra junto al máximo de tokens; el worker cancela el run al vencerlo.

Una cancelación normal cobra los tokens e imágenes medidos y libera la reserva restante. Si el worker muere, la cola mantiene la reserva al reintentar. Si el run fue cancelado durante la caída, el reconciliador cobra el consumo que quedó en eventos durables, incluye imágenes cuyo POST empezó y no terminó como ambiguas, y libera lo demás. Un run que agotó sus reintentos sin consumo medido libera la reserva. Los POST ambiguos de Meta no se reenvían automáticamente.

## Suspensión y recuperación

`RESOURCE_LIFECYCLE_ENABLED=false` por defecto. Para activarlo hacen falta PostgreSQL, bucket S3 privado, checkpoint store, controlador privado y `SANDBOX_DRIVER=rootless` en el host Linux dedicado. Mantén la bandera apagada en Windows/Docker Desktop: esa configuración no demuestra aislamiento de producción.

El worker reclama workspaces listos cuyo lease de sandbox y servidor de desarrollo venció. El lease de ciclo de vida usa un token compare-and-set y dura dos minutos. El sweeper omite runs y locks activos, sesiones de preview activas en Redis y añade un margen igual al TTL de sesión de preview antes de suspender. El enqueue y la creación del sandbox rechazan el lease mientras se captura la copia. Antes de suspender, el worker valida que la inspección del runtime esté lista y guarda un snapshot privado verificado por checksum y manifiesto. Si la captura, el cupo de storage o el commit de estado falla, el runtime queda intacto y el lease se libera. Un workspace sin `project-spec.json` válido tampoco se suspende.

Al despertar un workspace suspendido, el controlador crea el sandbox administrado y el worker valida identidad, checksum y conjunto exacto de archivos antes de reponerlos. Solo entonces limpia por CAS los metadatos del snapshot y lo elimina de S3. Si la restauración falla, el snapshot se conserva para reintento.

## Borrado de proyecto y cuenta

Eliminar un proyecto oculta datos y revoca la preview en la transacción de la API. El worker detiene inmediatamente el contenedor de ese registro administrado, pero conserva el volumen hasta que venza la retención. Tras la retención, elimina el runtime/volumen, assets, snapshots de versiones y suspensión, checkpoints y artefactos publicados; después borra filas privadas y marca la tarea durable `succeeded`. La fila del proyecto y la tarea permanecen como traza sin el transcript.

Eliminar una cuenta requiere su contraseña actual. Revoca las sesiones y enlaces de un solo uso, borra email/hash de contraseña, invalida acceso a los proyectos y revoca previews/publicaciones. Los proyectos se renombran de forma genérica y cada uno recibe una tarea de limpieza. La fila de usuario queda como tombstone con ID opaco y fecha de borrado para mantener ownership/auditoría; no se permite iniciar sesión, crear proyectos ni resolver recursos con esa identidad.

`PROJECT_DELETION_RETENTION_DAYS` controla el tiempo entre la solicitud de borrado y la eliminación física, con valor por defecto 30 días y rango 0–3650. Errores se registran como códigos sanitizados en `project_cleanup_tasks`; el reconciliador reintenta con lease y `skip locked`. Los borrados de S3 y Docker se limitan a claves/IDs recuperados del registro con owner y proyecto verificados. Una publicación revocada deja de servirse antes de borrar su objeto.

## Operación y límites pendientes

`RESOURCE_LIFECYCLE_ENABLED=true npm run resources:reconcile` ejecuta una pasada manual (contenedores de proyectos borrados en pausa, suspensión TTL y limpieza de proyectos vencidos). El worker ejecuta las mismas pasadas cada 30 segundos. Ambos necesitan la configuración privada de cada servicio; nunca copies `.env.local` a otro proceso. Consulta sus salidas por contadores, sin IDs ni contenido de usuario.

Los límites duros de CPU/RAM/PIDs/disco dependen de cgroups v2 y cuotas de filesystem del host. Deben probarse con `npm run sandbox:host-check` en el host Linux dedicado antes de activar la bandera. Los tests PostgreSQL/Redis/S3 con servicios locales y los mocks de controlador verifican contratos y reconciliación; no acreditan rootless real, DNS/TLS, permisos S3 productivos ni el proveedor de correo. Una tarea fallida conserva el registro para reintento y no autoriza borrar recursos de otro proyecto.
