# Runbook: backup y restore local

## Backup

1. Confirma el estado interno con `npm run infra:config` y `docker compose -f infra/compose.yml --env-file infra/.env ps`.
2. Asegura que el keyring local contenga la clave activa de 32 bytes Base64 y las claves anteriores necesarias. Los placeholders no cifran.
3. Ejecuta `npm run backup:create`. El comando detiene escritores Compose, respeta el cierre del worker, copia la base configurada y ambos buckets Silo, cifra el contenido y reinicia los procesos que estaban arriba.
4. Registra la ruta y los contadores que imprime el CLI. Copia la carpeta cifrada a una ubicacion independiente administrada por el operador; no guardes la clave junto al backup.

## Restore de ensayo

1. Elige una base nueva y dos buckets vacios con nombres validos.
2. Ejecuta:

   ```sh
   npm run backup:restore -- --backup-dir .\backups\encrypted\forja-backup-<id> --database-name forja_restore --bucket-private forja-restore-private --bucket-public forja-restore-public
   ```

3. Verifica conteos y hashes desde la app apuntada temporalmente a los destinos restaurados. No cambies el entorno activo antes de comparar proyecto/versiones/assets y abrir un snapshot privado.
4. Mantiene el backup original y todas sus claves hasta terminar el ensayo. Si falla, el CLI elimina solo la base y buckets que creo en este intento; confirma estado con Compose antes de volver a intentarlo.

## Rotacion

Para la clave de backup, agrega un nuevo `keyId` al objeto `BACKUP_ENCRYPTION_KEYS`, cambia `BACKUP_KEY_ID`, crea un backup, y comprueba que una restauracion acepta la clave nueva. Conserva claves antiguas hasta que venza `BACKUP_RETENTION_DAYS` y exista una copia independiente verificada.

Para rotar grants preview, genera un par RSA local nuevo fuera del repositorio. Cambia `PREVIEW_TOKEN_KEY_ID` y `PREVIEW_TOKEN_PRIVATE_KEY`; actualiza `PREVIEW_TOKEN_PUBLIC_KEYS` con la clave nueva y conserva la clave publica anterior durante `PREVIEW_TOKEN_TTL_SECONDS` mas un margen de reloj. Reinicia web y preview-gateway coordinadamente, emite/canjea un grant de prueba y luego elimina la clave publica vieja. Nunca registres ni copies las claves al chat/issue. Si la rotacion debe revocar sesiones preview ya canjeadas, cambia el epoch/revoca sesiones mediante el procedimiento de preview antes de retirar la clave.

Para otros secretos de operador (Meta, auth, SMTP, worker y S3), actualiza el archivo local protegido o gestor elegido, rota primero el destino y reinicia solo los servicios consumidores. No uses `docker compose config` sin `--quiet`, `docker inspect` sin filtros, ni logs que incluyan el entorno.

El ensayo medido y su alcance estan en [evidencia de recovery](../backup-restore-report.md); la guia completa esta en [operacion issue #26](../operations-issue-26.md).
