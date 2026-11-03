# Herramientas de inspección de assets Phaser

`inspect_asset` ofrece al agente una lectura estructurada antes de que cambie un juego. Acepta exactamente una fuente: `assetId` para una imagen privada registrada o `workspacePath` para un asset del workspace actual. La identidad sale del claim verificado del run; `userId`, `projectId`, URL y host no se reciben en argumentos del modelo.

La herramienta solo recibe lectores. No tiene métodos de escritura, no inicia instalaciones ni comandos y no hace solicitudes de red. Los assets privados se leen por el adaptador S3 del servidor, que comprueba owner, estado, tamaño y checksum. Un asset de otro owner, otro proyecto del mismo owner o inexistente devuelve `OwnedResourceNotFoundError` con el mismo mensaje.

## Formatos y límites

- PNG, JPEG, WebP y GIF se decodifican con `sharp`; se comprueban MIME real, checksum, dimensiones, píxeles y, si se pide, alpha. El límite del inspector es 8 MiB, 2.048 píxeles por lado y 40 millones de píxeles.
- Atlas: Phaser JSON Hash con `meta.image`, `meta.size` y `frames` como objeto o arreglo. Revisa rectángulos positivos, límites de textura, solapes, nombres únicos y pivotes normalizados de 0 a 1. Si se solicita `atlas-references`, también decodifica la textura y compara sus dimensiones.
- Tileset: subset finito de Tiled/Phaser o descriptor JSON con `image`, tamaño de tile, columnas, conteo, margen, separación y propiedades de colisión. Verifica que la cuadrícula y cada id entren en la textura.
- Tilemap: mapa Tiled finito o descriptor con capas de celdas `{x, y, index}`. Comprueba tamaño de capas, ids, límites y coordenadas repetidas; relaciona los tiles con el tileset y sus propiedades de colisión.
- Animación: descriptor con `key`, `fps`/`frameRate`, lista ordenada `frames` y `atlasPath`. Comprueba 1–256 nombres, fps de 1–60, duplicados y referencias exactas al atlas.
- Manifest generado: `schemaVersion: 1` y hasta 128 entradas con ID, key, path y cuadrícula derivadas del mismo ID. Decodifica cada imagen y compara las dimensiones con los frames declarados.
- Los descriptores están limitados a 1 MiB; los reportes a 24.000 bytes; cada lista de frames/celdas se limita a 4.096 elementos y cada mapa a 16 capas.

La inspección distingue `valid`, `invalid` y `needs_review`. Los hallazgos tienen severidad y códigos estables. `phaser-runtime` nunca convierte un resultado estático en `valid`: exige confirmar la carga en la preview. La validación visual sigue siendo una comprobación distinta.

## Edición de sprites (#31)

`edit_sprite` requiere `sourceAssetId`, una instrucción corta y los cuatro booleanos de preservación. `sourceFrameIndex` selecciona un frame entre 0 y 63 (por defecto, 0); `view` y `palette` son restricciones opcionales. La identidad del owner y el proyecto vienen del claim del run. El source debe ser un sprite PNG generado y registrado en el manifest runtime del mismo proyecto. Antes de reservar cuota, se comprueban ownership, SHA-256, MIME real, dimensiones, grilla, alpha y existencia del frame; no se infiere el asset más reciente.

El worker recorta el frame exacto y lo envía a `MetaClient.editImage` como `input_image` base64 junto al prompt de edición, el formato de referencia documentado por [Meta para Muse Image](https://dev.meta.ai/docs/image-generation). Meta no recibe una URL ni puede elegir otra imagen. Si `preserve.canvas` está activo, la normalización conserva las dimensiones del frame con ajuste proporcional y padding transparente. La edición crea un asset y una hoja QA nuevos, conserva intacto el source y añade al manifest una entrada Phaser de un frame. El metadata privado registra `sourceAssetId`, `sourceSha256`, frame original e instrucción filtrada bajo `provenance: "meta-image-edit"`; la revisión queda `pending-in-live-preview`.

`callId` reutiliza el resultado durable si la tool ya terminó. Si el POST de imagen queda ambiguo, el run conserva la reserva y falla cerrado; el orquestador no vuelve a llamar al proveedor ni informa éxito. El PNG debe pasar inspección y verse en la preview antes de que el usuario acepte el cambio.

La aceptacion `npm run test:assets:acceptance` prepara PostgreSQL y Silo temporales en el Compose local, ejecuta `edit_sprite` con Meta mock y almacena source y derivacion con el storage privado real. Luego Playwright carga en la plantilla Phaser los bytes recuperados de Silo y valida atlas, pivotes, orden/FPS, tiles, colisiones y captura; el script elimina sus recursos temporales al terminar.

## Tilesets deterministas (#32)

`create_tileset` compone PNGs cuadrados existentes del mismo proyecto. Cada source debe tener UUID en el manifest runtime, metadata de imagen registrada y un frame PNG cuadrado exactamente del `tileSize` pedido. Admite 1–256 entradas, frames fuente 0–63, tileSize de 8–128 px, columnas de 1–16 y hasta 16 filas. Si se omiten columnas, usa `min(16, cantidadDeTiles)`. No reescala, rota ni vuelve a generar arte; `input-order-row-major` asigna `tileIndex` desde cero en el orden recibido y completa la última fila con transparencia.

La tool valida cada source por sesión propia/owner, proyecto, estado, MIME, SHA-256, PNG real, dimensiones y grilla antes de escribir. `assets/generated/tilesets/<uuid>.png` y el descriptor JSON versionado se suben como objetos privados separados. El manifest del workspace `public/assets/generated/tilesets/manifest.json` registra la pareja y sus dimensiones. IDs derivados de `(runId, callId)` y storage con comprobación de contenido permiten repetir una llamada sin duplicar objetos ni entradas. Los writes incompletos se compensan con eliminación de archivos y objetos recién creados.

La plantilla expone `parseGeneratedTilesetMetadata`, `addGeneratedTileset` y `applyGeneratedTilesetCollisions` desde `packages/game-templates/phaser/src/game/tilesets.ts`. El adaptador verifica versión, rutas, dimensiones, nombres e índices; carga en `Phaser.Tilemaps.Tileset.tileProperties` el nombre, la colisión y el terreno por índice local, y devuelve `firstgid`, índices locales/globales y los índices colisionables para el creador del tilemap.

## Contratos

Los tipos Zod compartidos viven en `packages/contracts/src/asset-tools.ts`. El mismo módulo exporta JSON Schema Draft-7 de entrada y salida; el adaptador de tools de Meta transmite el schema explícito con `oneOf` para excluir solicitudes que mezclen ID y ruta. Zod se vuelve a ejecutar cuando el worker prepara cada llamada.

## Comprobaciones locales

```sh
npx vitest run tests/assets/inspect-asset.test.ts
npx vitest run tests/assets/edit-sprite.test.ts tests/meta-client.test.ts tests/unit/orchestrator.test.ts
npm run infra:up
npx playwright test --config tests/assets/playwright.config.ts
npm run test:integration
```

La prueba de integración usa PostgreSQL y Silo en Docker Compose con assets sintéticos y dos owners. Playwright ejecuta la tool sobre PNG y descriptores reales de prueba, sirve los mismos bytes a una escena Phaser 3.90 y comprueba rectángulos/pivotes del atlas, secuencia y frecuencia de animación, colisión de suelo y píxel renderizado. La evidencia queda en `docs/evidence/issue-30-asset-inspection.md` y `docs/evidence/issue-30-phaser-assets.png`. La prueba usa fixtures deterministas; no llama a Meta ni consume cuota.

Para la edición, `tests/integration/edit-sprite.test.ts` usa Postgres y Silo reales de Compose con un mock de Meta; verifica bytes fuente, ownership de dos cuentas y persistencia del derivado. `tests/assets/edit-sprite-preview.spec.ts` ejecuta la misma tool con un frame PNG sintético, integra el resultado en un atlas Phaser y usa Chromium para comprobar cada frame, pivotes, orden/FPS y colisiones de tiles. La evidencia se guarda en `docs/evidence/issue-31-sprite-edit-preview.md` y `docs/evidence/issue-31-sprite-edit-preview.png`.

Para tilesets, `tests/integration/create-tileset.test.ts` ejecuta la tool con PostgreSQL/Silo de Compose, confirma los dos objetos privados, reintento por `callId` y rechazo de un source de otro owner. `tests/assets/create-tileset-preview.spec.ts` carga los bytes recuperados de Silo en Phaser 3.90 con Playwright Chromium; revisa colores renderizados para cada tile, mapping por nombre, `firstgid`, propiedades de colisión/terreno y el aterrizaje del jugador en la plataforma. `npm run test:assets:acceptance` ejecuta ambas aceptaciones. Evidencia: `docs/evidence/issue-32-phaser-tileset.md` y `docs/evidence/issue-32-phaser-tileset.png`.
