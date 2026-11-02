# Catálogo de presets

`catalog.json` describe los controles, objetivos y estados de victoria/derrota de los cuatro géneros que soporta la plantilla. Las mecánicas ejecutables están dentro de `phaser/src/game/PlayScene.ts` y sus reducers puros en `phaser/src/game/logic.ts`; así el proyecto Phaser puede copiarse como una unidad. `tests/game-templates/catalog.test.ts` mantiene sincronizado este catálogo con los objetivos del runtime.

Cada preset incluye un objetivo alcanzable, al menos una condición de derrota, tres vidas, reinicio con `R`, controles de teclado/táctiles y assets locales. Solo plataformas y shooter necesitan Arcade Physics; puzzle y RPG usan movimiento discreto por casillas.
