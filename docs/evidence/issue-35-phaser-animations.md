# Evidencia de aceptación #35

Fecha UTC: 2026-11-03T07:41:34.948Z

pack_spritesheet procesó cuatro frames privados y define_animation validó el atlas registrado de PostgreSQL/Silo y guardó su manifiesto versionado también en PostgreSQL/Silo. Phaser 3.90 cargó los bytes exactos en la preview.
Atlas: cuatro rectángulos con dimensiones originales; Phaser resolvió run_0, run_1, run_2 y run_3, todos dentro de la textura, sin solapes y con pivote (0.5, 1).
Animación con reloj Playwright controlado: acceptance-run recorrió run_0 → run_1 → run_2 a 6 fps (ciclo mediano 500.0 ms); acceptance-yoyo validó run_0 → run_1 → run_0, repeat=1, yoyo, 8 fps y delays de 50/25 ms. La escena se reinició conservando solo las dos claves.
Tilemap y tileset de #33 recuperados de Silo: las cuatro muestras renderizadas fueron RGB (35,115,230), (38,220,80), (190,70,225), (230,190,35). El actor cayó y quedó en y=64.0 sobre ground; la capa props no activó colisión.
La integración creó los PNG sintéticos localmente y los subió a PostgreSQL/Silo; no llamó a Meta ni utilizó un mock de almacenamiento.

Captura: docs/evidence/issue-35-phaser-animations.png.
