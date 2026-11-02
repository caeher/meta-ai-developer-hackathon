# Snapshots y restauración de versiones

`apps/worker/src/versions/` captura archivos después de una verificación aprobada. El snapshot gzip privado incluye GameSpec, reporte de checks, manifiesto de archivos, tamaños y SHA-256, además de texto y assets binarios permitidos. Las claves se derivan en el servidor desde owner/proyecto/versión; la API de navegador nunca recibe `snapshotKey`.

Se omiten `.env*`, credenciales conocidas, archivos con contenido sensible detectado, `node_modules`, builds, cachés, informes de pruebas y archivos binarios fuera de `public/assets/`. Límites por defecto: 512 archivos, 8 MiB por archivo, 20 MiB expandidos y 25 MiB comprimidos. `SNAPSHOT_MAX_FILES`, `SNAPSHOT_MAX_FILE_BYTES`, `SNAPSHOT_MAX_TOTAL_BYTES` y `SNAPSHOT_MAX_ARCHIVE_BYTES` permiten reducirlos en configuración validada; no permiten superar los topes compilados. La lectura verifica tamaño, hash, esquema, identidad y límite de expansión gzip antes de restaurar.

`GET /api/projects/{projectId}/versions` pagina hasta 50 versiones listas; `GET /api/projects/{projectId}/versions/{versionId}` devuelve el manifiesto; `POST /api/projects/{projectId}/versions/{versionId}/restore` verifica origen y ownership en web y vuelve a validar la sesión/versión en worker. Restore toma el lock de proyecto, rechaza runs activos, guarda un backup del workspace, aplica y relee archivos, compara hashes y crea una nueva versión hija. Si falla la aplicación, intenta restaurar el backup antes de liberar el lock.

El editor mantiene `Latest` en la última versión verificada y permite revisar GameSpec, cambios y checks desde el selector. Restaurar crea una versión nueva y regresa la preview al workspace restaurado. Elegir una versión histórica aún abre el resumen; no presenta una preview jugable histórica, porque el gateway solo resuelve el sandbox activo y no existe todavía un runtime aislado temporal por snapshot. No se altera el workspace al revisar un resumen.

## Validación

- `npm test` cubre exclusión de `.env.local`, snapshots con assets binarios, checksums, restore como tercera versión, rollback, owner/CSRF de las rutas y autenticación del endpoint interno.
- `npm run test:integration` incluye migraciones y repositorio de versiones sobre Postgres local; el S3 de prueba es temporal y privado. La fixture no demuestra ejecución del sandbox rootless.
- La prueba de integración del worker contra S3 y sandbox real, reconciliación automática de objetos si el proceso cae entre `PutObject` y la confirmación SQL, preview histórica, y validación en host Linux siguen pendientes. El gateway y las ejecuciones permanecen tras sus feature flags y configuración operativa.
