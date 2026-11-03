Tool y asset ejecutados/persistidos en Postgres/Silo de Docker Compose; Playwright cargo los bytes leidos del asset privado.
# Evidencia de aceptación #31

Fecha UTC: 2026-11-03T06:14:25.149Z

La tool editó el frame 1 de un sprite privado de tres frames usando Meta mock; el mock verificó que la referencia enviada correspondía exactamente al assetId y frame pedidos. Hash de origen 858b7feedaef8e04e380a0fe0bf34fd2079bae6b6f6651150608cb629e421405; hash derivado 9d09a8caceb8d6cbe8a0c7a7bdb2d129d7adcaeb002b2fa2c6ef40d12b24834b. El asset fuente permaneció byte por byte igual.
La inspección de la imagen editada, atlas, animación, tileset y tilemap produjo cinco reportes valid. Atlas Phaser: 3 frames, rectángulos sin solape ni desborde y pivotes (0.5, 1).
La captura se tomó mostrando run_1; el píxel central de ese frame en el canvas coincide con RGB(23, 143, 138) del PNG editado.
La animación recorrió run_0 → run_1 → run_2 a 6 fps; intervalo mediano observado del frame editado: 500.6 ms.
El tileset de 2 celdas se renderizó; 8 celdas de suelo tuvieron colisión y el jugador aterrizó en y=64.0. Muestra del tile: RGB(38, 220, 80).
Runtime: plantilla de preview Phaser 3.90.0, Vite y Playwright Chromium. No se llamó Meta ni se consumió cuota.

Captura: `docs/evidence/issue-31-sprite-edit-preview.png`.
