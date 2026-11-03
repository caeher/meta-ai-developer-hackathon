# ADR 0002: persistencia multiusuario y objetos privados

- Estado: aceptado.
- Fecha: 2026-11-02.

## Contexto

Los proyectos, mensajes, runs, eventos, sandboxes, assets, versiones, publicaciones y mediciones de uso deben sobrevivir a reinicios y mantener ownership verificable. Las claves privadas de objetos no deben llegar al navegador. La base de datos es la fuente de verdad; S3 almacena bytes y puede quedar temporalmente desfasado durante una falla de red.

## Decisiones

- PostgreSQL 17 y Drizzle ORM. El esquema TypeScript vive en `packages/db/src/schema`; SQL generado y versionado vive en `packages/db/migrations`. `drizzle-kit migrate` registra las migraciones aplicadas y no repite las que ya tienen historial.
- `users.user_id` conserva la identidad propia como clave única; los recursos usan UUID internos opacos. Cada repositorio requiere un `VerifiedIdentityContext` creado en el servidor tras validar una sesión propia. La autenticación completa se implementa en #29; el seed y las pruebas pueden crear contextos sintéticos solo fuera de producción.
- Cada recurso hijo guarda `owner_user_id` y `project_id`. Claves foráneas compuestas vinculan ambos al mismo proyecto y, donde aplica, vinculan run, versión o reserva sin permitir cruces entre dueños. Las lecturas ocultan recursos ajenos con un resultado indistinguible de inexistente.
- El adaptador solo usa `S3_BUCKET_PRIVATE`, deriva claves desde IDs internos y no acepta rutas/prefijos del cliente. Limita objetos a 25 MiB, restringe MIME, calcula SHA-256 y verifica metadata/tamaño luego de escribir. No emite URLs firmadas, no configura ACLs públicas y responde solo después de autorizar el owner.
- S3 y PostgreSQL no comparten transacción. La carga reserva metadata `pending`, escribe y valida el objeto, y luego marca `ready`. Si se pierde la respuesta de commit tras la escritura, conserva el objeto y la fila pendiente para reconciliar; si la eliminación falla, conserva `delete_requested`. El worker reconcilia automáticamente: los snapshots `creating` desde #21 y los assets `pending`/`delete_requested`/`failed` (ver `apps/worker/src/assets/reconcile-assets.ts`, cada 60 s con `RUNS_ENABLED=true`). Un `pending` con objeto verificado pasa a `ready`; sin objeto o corrupto pasa a `failed` tras borrar el resto; un `delete_requested` reintenta el borrado y elimina la fila; un error transitorio de S3 difiere la fila sin tocarla.
- Compose configura acceso anónimo `none` para los buckets locales. Para producción, el operador debe bloquear acceso público a nivel de bucket/cuenta y usar credenciales con permisos mínimos antes de conectar el adaptador. El código no puede neutralizar una política de bucket externa que conceda lectura anónima.

## Migración y rollback

`0000_normal_chameleon.sql` crea el esquema inicial con secuencia en el ledger; `0001_dazzling_red_skull.sql` convierte su ID a UUID y conserva las filas. El segundo paso deja compatibles las bases locales que ya habían aplicado la primera ejecución durante el desarrollo y no repite cambios sobre una base nueva. `0000_normal_chameleon_down.sql` elimina el esquema completo y solo sirve para una base local descartable. `0001_dazzling_red_skull_down.sql` vuelve a generar IDs secuenciales, por lo que los IDs/cursors previos no se conservan. Ningún rollback se ejecuta desde `db:migrate`; usar backup para conservar identidades y ejecutar estos scripts únicamente en una base descartable. Las siguientes migraciones serán aditivas y describirán un rollback específico junto a su SQL.

## Consecuencias

- Las consultas de ownership y restricciones de base trabajan juntas: el filtro de repositorio devuelve 404 uniforme y PostgreSQL rechaza incluso escrituras internas inconsistentes.
- La paginación usa cursores estables con límite máximo; los eventos usan secuencia asignada bajo lock del run.
- Los tests integrados crean una base y un bucket privados temporales locales, verifican la lectura anónima y eliminan ambos al terminar.
- La conexión real a un bucket de producción sigue pendiente; se validará selección del proveedor, bloqueo de acceso público, IAM y cifrado antes del despliegue.

## Proyectos privados y chat (issue #6)

- `projects.deleted_at` es una marca lógica. Todas las lecturas/listas/creaciones/mutaciones de proyecto y transcript filtran proyectos activos y responden `404` al dueño o a otra cuenta cuando el registro fue eliminado.
- `messages.sequence` se asigna bajo lock de fila del proyecto para ordenar de forma estable; `request_id` es único por owner/proyecto. Un reintento idéntico devuelve el mensaje original y una clave reutilizada con otro contenido genera conflicto.
- La eliminación bloquea el proyecto y, en una transacción, cancela runs activos, marca sandbox/asset/snapshot para limpieza, revoca publicaciones y agrega un registro `project_cleanup_tasks`. La app web no destruye volúmenes ni objetos S3; el servicio de ciclo de vida del worker (#23, `apps/worker/src/lifecycle/service.ts`) reconcilia esa cola, retira jobs de BullMQ y borra objetos/volúmenes tras la retención. El borrado lógico no purga contenido ni equivale a la política de retención final.
- `0002_lying_brother_voodoo_down.sql` elimina las columnas/tarea añadidas. PostgreSQL no quita valores de enums; el script reconstruye `version_status` y fallará si una fila conserva `delete_requested`. Exportar/resguardar datos antes de un rollback y no ejecutarlo directamente en producción.
