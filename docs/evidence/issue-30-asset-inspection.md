# Evidencia de aceptación #30

Fecha UTC: 2026-11-03T05:45:31.054Z

La tool `inspect_asset` recorrió imágenes, atlas, animación, tileset y tilemap con PNG reales generados para esta prueba; los cinco reportes fueron `valid`.
Atlas: 3 frames Phaser cargados; cada pivote quedó en (0.5, 1); los rectángulos y límites pasaron el inspector. SHA-256 del descriptor del atlas: d23669a7961cd43ac837aff591b0864c44e6d194ca84da2505dbdcd8cc667715.
Animación: secuencia observada run_0 → run_1 → run_2 a 6 fps; mediana observada de un ciclo: 500.7 ms.
Tileset/tilemap: 2 tiles, 8 celdas de colisión; el jugador aterrizó en y=64.0 y la muestra de render fue RGB(38, 220, 80).
Runtime: preview local Phaser 3.90.0 en Vite y Chromium Playwright. Los archivos de entrada son fixtures generados por sharp; Meta no fue llamado ni se cobró uso.

Captura: `docs/evidence/issue-30-phaser-assets.png`.
