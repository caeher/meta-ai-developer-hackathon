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

## Contratos

Los tipos Zod compartidos viven en `packages/contracts/src/asset-tools.ts`. El mismo módulo exporta JSON Schema Draft-7 de entrada y salida; el adaptador de tools de Meta transmite el schema explícito con `oneOf` para excluir solicitudes que mezclen ID y ruta. Zod se vuelve a ejecutar cuando el worker prepara cada llamada.

## Comprobaciones locales

```sh
npx vitest run tests/assets/inspect-asset.test.ts
npm run infra:up
npx playwright test --config tests/assets/playwright.config.ts
npm run test:integration
```

La prueba de integración usa PostgreSQL y Silo en Docker Compose con assets sintéticos y dos owners. Playwright ejecuta la tool sobre PNG y descriptores reales de prueba, sirve los mismos bytes a una escena Phaser 3.90 y comprueba rectángulos/pivotes del atlas, secuencia y frecuencia de animación, colisión de suelo y píxel renderizado. La evidencia queda en `docs/evidence/issue-30-asset-inspection.md` y `docs/evidence/issue-30-phaser-assets.png`. La prueba usa fixtures deterministas; no llama a Meta ni consume cuota.
