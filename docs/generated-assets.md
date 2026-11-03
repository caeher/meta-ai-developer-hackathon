# Imágenes generadas para juegos (#19)

## Flujo

`generate_image` es una herramienta privada del worker. El modelo recibe un brief Zod con tipo de asset, descripción, estilo, vista, paleta, transparencia, cantidad de frames y, para tilesets, tamaño y repetición. El router de skills carga `create-game-assets` cuando la tarea pide sprites, arte, fondos o tilesets; su guía se trata como contexto consultivo. El prompt añade la escala Phaser 3.90, la grilla y restricciones de salida. La imagen se solicita a `META_MODEL_IMAGE` (`muse-image-1.0` por defecto), sin búsqueda externa, shell, URL arbitraria ni proveedor de respaldo.

Cuando el proyecto ya tiene assets generados, el worker lee el último del manifest runtime desde el storage privado con identidad verificada. Comprueba que pertenezca al mismo proyecto, que su metadata de generación, tipo, dimensiones y checksum coincidan con el manifest y que el PNG decodifique. Envía una versión PNG acotada (máximo 512 KiB) como `input_image` junto al brief. Meta solo recibe los bytes privados seleccionados, nunca una URL. El prompt limita la referencia a estilo, paleta, trazo, iluminación y escala; mantiene el sujeto y la vista del brief. El primer asset no incluye referencia. El metadata del nuevo asset registra el ID y SHA-256 de la referencia usada.

Antes del `POST`, el worker reserva una imagen bajo lock de owner y persiste `agent.meta_request_started`. La reserva se hace dentro de PostgreSQL y respeta `USER_DAILY_IMAGE_LIMIT`. Si ya existe un inicio durable para la misma clave, no se llama otra vez a Meta. Una solicitud sin respuesta durable queda ambigua y se carga conservadoramente como intento; ningún timeout o caída provoca un reintento facturable silencioso. Una respuesta completada registra modelo, IDs de respuesta y uso medido.

## Validación y normalización

- Meta entrega bytes base64 documentados; el cliente limita la fuente a 20 MiB y acepta únicamente PNG, JPEG y WebP con firma y dimensiones válidas, hasta 8.192 px por lado y 40 MP. No descarga URLs del proveedor.
- El worker vuelve a comprobar MIME, metadatos decodificados, dimensiones y presupuesto de píxeles. Para una solicitud transparente requiere canal alfa y píxeles con alpha menor que 255. Un canal presente pero completamente opaco no satisface el brief.
- Sharp reorienta según EXIF, quita metadata de salida y re-encodea a PNG. Los assets se limitan a 2.048 px por lado, 40 MP y 8 MiB. Una grilla inválida o un PNG que excede esos límites falla sin registrarse como asset listo. Los frames se recortan por celdas exactas y se genera una hoja de contacto.
- Para un tile repetible se crea una hoja 3×3 y se mide la diferencia media entre bordes opuestos. El umbral solo marca `reviewRequired`; no certifica seams, autotiling ni combinaciones de terreno. El usuario todavía debe observar el asset en la preview del juego.

## Ownership y juego

El PNG y su hoja de contacto se escriben en el bucket S3 privado mediante el repositorio que comprueba autenticación propia owner y proyecto. El metadata conserva modelo, prompt saneado por filtros, timestamp, hashes, dimensiones, alpha, grilla, ediciones, hoja de contacto y estado de revisión. Los objetos tienen checksum y el estado de upload se verifica antes de usarse. La clave de S3 no se expone.

El worker copia el PNG normalizado a `public/assets/generated/<uuid>.png` mediante `write-binary-file`, que solo acepta esa ruta y hasta 8 MiB. La herramienta escribe el manifest runtime con ID, ruta relativa, tipo, frames y dimensiones. Phaser valida el manifest estricto, carga los PNGs en su cache y los registra como `generated-<uuid>`; el modelo puede usar esa clave desde las escenas del proyecto. `file.changed` publica solo la ruta y bytes escritos. No expone prompt, modelo, hash, IDs privados ni contenido del archivo. El servidor Vite actualiza la preview tras el health check.

`visualReview: "pending-in-live-preview"` se persiste junto al asset y la hoja de contacto. La automatización registra estructura, alpha, frames y heurística de seams; la aprobación artística humana debe realizarse viendo la preview en contexto. No se etiqueta un asset como aprobado a partir del prompt, la hoja de contacto o la prueba de carga de Phaser.

## Configuración y verificación

No hay nuevas claves. `META_MODEL_IMAGE`, `S3_*` y `USER_DAILY_IMAGE_LIMIT` ya están definidos en `.env.example`. El worker habilitado necesita S3 privado y el runtime; `RUNS_ENABLED=false` y `SANDBOX_DRIVER=disabled` siguen cerrados por defecto. La llamada `npm run meta:smoke -- --image` puede facturar una imagen y es opt-in; la suite local usa fixtures y no lee `.env.local`.

```sh
npm test -- tests/assets tests/unit/orchestrator.test.ts tests/unit/run-events-handler.test.ts tests/meta-client.test.ts tests/sandbox.test.ts tests/storage.test.ts
npm run build:worker
npm run build:game-template
npm run typecheck
npm run lint
```

Los tests generan PNG/JPEG/WebP sintéticos e incluyen corrupción, MIME falso, alpha opaco, límites, frames, repetición 3×3, cuota, ownership pasado por identidad verificada, registro Phaser y proyección SSE con payload privado omitido. No sustituyen una generación real, una captura artística en juego ni una prueba de almacenamiento cruzado con dos cuentas reales. La aceptación pendiente es un recorrido E2E con dos cuentas y Silo/sandbox/preview dentro de Compose; una llamada real de Meta es opt-in y facturable.

## Verificación real local (2 de noviembre de 2026)

Una llamada real a `MetaClient.generateImage` con muse-image-1.0 produjo un PNG de 1.174.046 bytes y 2048×1152 píxeles. `processGeneratedImage` lo aceptó para un fondo opaco solicitado y generó un PNG normalizado de 680.361 bytes, SHA-256 2cb4ed2b1320aa26a43c72fee7fcb23ac492edd0575ad5260b813757a5ff007b. No se exigía alpha.

El PNG normalizado se sirvió desde el template Phaser mediante un manifest local: el navegador recibió HTTP 200, Phaser reportó `assetsReady=true` y registró generated-afe01e20-8b72-4cf2-b077-4510e5ef0f7e sin errores. Se inspeccionó el fondo detrás del nivel mediante una capa temporal de QA; el código y assets temporales se retiraron del repo. La captura queda en `%TEMP%\meta-issue19-5HDmpK\phaser-preview.png`.

Esta prueba acredita una respuesta real de Meta, el decodificador/normalizador, la carga Phaser del manifest y una revisión visual local. No pasó por la reserva facturable del worker ni persistió ese resultado en el bucket privado o en un proyecto con sesión autenticación propia. `visualReview` permanece `pending-in-live-preview` para los assets de producto hasta observar una generación real desde la preview privada. Las pruebas de integración locales ejercitan S3 privado y rechazan lectura con otra identidad fixture; falta el recorrido E2E con dos cuentas, runtime y preview dentro de Compose.

Validación en Node 24.22.1: `npm test` pasó 184 pruebas y omitió 24 de integración; `npm run test:integration` pasó 30 y omitió una comprobación opcional de Redis preview; `npm run test:e2e:game-templates` pasó 18 pruebas en Chromium, Firefox y WebKit. `npm run lint`, `npm run typecheck`, `npm run build`, `npm run build:worker` y `npm run build:game-template` también pasaron. Las pruebas locales no habilitan `RUNS_ENABLED` ni acreditan la preview privada real.
