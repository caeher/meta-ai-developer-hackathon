# ADR #19: assets generados con provenance y validación determinista

Estado: aceptada para el worker; generación real y host Linux dedicado pendientes de validación operativa.

## Contexto

Meta Image puede devolver bytes de imagen, pero un prompt no demuestra dimensiones, transparencia efectiva, grilla, repetibilidad ni uso correcto dentro de Phaser. Las imágenes son salida no confiable y los PNG generados deben mantenerse privados mientras pertenecen a un proyecto.

## Decisión

- El worker usa `MetaClient.generateImage` con el modelo configurado por `META_MODEL_IMAGE`, sin fallback de proveedor ni descarga de URL. El payload desactiva image search, web search y shell.
- Un brief validado fija el tipo, descripción, estilo, vista, paleta, alpha solicitado, grilla y, para tilesets, tamaño/repetición. Se reserva una imagen bajo lock PostgreSQL antes del POST. Los requests ambiguos se marcan y no se repiten automáticamente; su uso se carga conservadoramente.
- El worker valida bytes/firma y vuelve a decodificar formato, píxeles, dimensiones y alpha. Sharp normaliza orientación, elimina metadata, recorta frames de una grilla válida y genera hojas de contacto. Los límites del proyecto son fuente 20 MiB, PNG normalizado 8 MiB, lado 2.048 px y 40 MP.
- Un tile repetible se inspecciona con repetición 3×3 y una medida de diferencias en bordes. Esta medida solo solicita revisión cuando supera el umbral configurado; nunca aprueba por sí sola seams, colisiones o autotiling.
- PNG, hoja QA y metadata de procedencia se almacenan en el bucket privado con identidad y proyecto verificados. La copia de ejecución va al sandbox usando una operación binaria restringida a `public/assets/generated/`. Phaser acepta únicamente el manifest estricto de assets generados y usa keys deterministas derivadas de UUIDs.
- `visualReview` comienza como `pending-in-live-preview`. La preview permite al usuario revisar arte en contexto; la automatización no declara calidad visual a partir del prompt o de los metadatos técnicos.

## Consecuencias

Se añade `assets.metadata` JSONB con backfill vacío y una migración de reversión explícita. El ledger mide imágenes y tokens; los precios de Meta no se fijan en código porque pueden cambiar. `RUNS_ENABLED=false` y `SANDBOX_DRIVER=disabled` siguen siendo los defaults. Fixture tests y build no demuestran disponibilidad de cuenta/región, cobro real, storage desplegado, ownership con dos cuentas, rootless Linux ni revisión artística de una generación real.

Más detalle y comandos de comprobación: [assets generados](../generated-assets.md).
