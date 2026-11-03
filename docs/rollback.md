# Rollback local de Compose (#27)

El rollback del staging es interno y conserva los datos. No usa un host remoto ni modifica DNS público.

## Desactivar una capacidad

Ante un fallo de preview, publicación o ejecución, corta primero el proceso que la sirve. La aceptación siguiente vuelve a crear el gateway, origen y controlador con claves locales nuevas; los defaults productivos son `RUNS_ENABLED=false`, `PREVIEW_GATEWAY_ENABLED=false` y `PUBLISHING_ENABLED=false`.

```powershell
docker compose --file infra/compose.yml --env-file infra/env.example stop worker preview-gateway publishing-origin sandbox-controller
```

Para apagar todo el entorno sin borrar datos:

```powershell
npm run infra:down
```

No ejecutes `down --volumes` como rollback.

## Volver al código conocido

Registra el commit validado antes de cambiar la versión. Si una entrega local rompe una capacidad, crea un commit de reversión con `git revert <commit>` y reconstruye los perfiles mediante `npm run infra:up -- --acceptance`. La compilación toma el código de `main`; los volúmenes existentes se conservan.

Los cambios de esquema son aditivos y no se revierten automáticamente. Si una migración no es compatible con la versión anterior, restaura un backup en una base y buckets vacíos y apunta la aplicación restaurada a esos destinos después de verificar el contenido. No sobrescribas la base o los buckets activos.

## Datos y backups

Antes de un cambio que altere datos, crea un backup cifrado y conserva una copia independiente:

```powershell
npm run backup:create
```

Ensaya la restauración contra nombres nuevos y vacíos según [backup y restore](runbooks/backup-restore.md). El simulacro medido de Postgres y ambos buckets Silo está en [evidencia de recuperación](backup-restore-report.md). Mantén la clave del backup fuera del repositorio y del backup cifrado.

## Publicaciones

Una publicación activa se revoca desde la sesión propia del proyecto; la fila pasa a `revoked` antes de borrar objetos del bucket. Para un artefacto incorrecto, revócalo, confirma que su URL devuelve 404 y publica solo una versión verificada nueva. No expongas el servidor de desarrollo ni reviertas la publicación hacia un bucket público.

## Verificación tras rollback

Comprueba healthchecks, `/api/health/readyz`, una sesión propia, ownership A/B, readiness del gateway/origen y el test de integración de storage. Revisa logs sanitizados y confirma que el backup y sus claves se pueden descifrar antes de cerrar el incidente. La matriz reproducible está en [verificación de staging](staging-verification.md).
