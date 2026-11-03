# Evidencia de aceptación #33

Fecha UTC: 2026-11-03T06:57:19.312Z

`create_tilemap` se ejecutó en la integración temporal de PostgreSQL/Silo. El resultado recuperado de Silo se cargó como Tiled JSON en Phaser 3.90 desde Vite y Chromium Playwright.
Tilemap 8×6, tile 16px, firstgid 1; capas en orden background → hidden → ground → props; 12 celdas no vacías y GID 0 para huecos.
Capas visibles: true, false, true, true; colisión activada solo en ground. El actor cayó sobre ground hasta y=64.0; el tile vacío y el tile sólido en props no bloquearon al segundo actor (y=70.3).
Render tile por tile, colores RGB: (35,115,230), (38,220,80), (190,70,225), (230,190,35). SHA-256 del JSON tilemap: 5376f721e9e8f6b9201cdc9f403d4ede20115362699115fbf5558ea75bd7198e.
El contrato de atlas y animación también se verificó en la misma aceptación mediante `inspect-preview.spec.ts`: rectángulos completos y sin solapes, pivotes (0.5, 1), secuencia run_0 → run_1 → run_2 y cadencia de 6 fps. Véase `docs/evidence/issue-30-asset-inspection.md`.
No se llamó a Meta; las imágenes originales son píxeles sintéticos del fixture local. La tool de tilemap consumió el tileset privado producido y almacenado por la tool real `create_tileset` en la base y Silo temporales de Compose.

Captura: `docs/evidence/issue-33-phaser-tilemap.png`.
