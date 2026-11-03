# Evidencia de aceptación #36

Fecha UTC: 2026-11-03T08:26:58.212Z

pack_spritesheet procesó cuatro frames privados y define_animation validó el atlas registrado de PostgreSQL/Silo y guardó su manifiesto versionado también en PostgreSQL/Silo. Phaser 3.90 cargó los bytes exactos en la preview.
Atlas: cuatro rectángulos con dimensiones originales; Phaser resolvió run_0, run_1, run_2 y run_3, todos dentro de la textura, sin solapes y con pivote (0.5, 1).
Animación: acceptance-run recorrió run_0 → run_1 → run_2 a 6 fps (ciclo mediano 500.0 ms); acceptance-yoyo validó run_0 → run_1 → run_0, repeat=1, yoyo, 8 fps y delays de 50/25 ms. La escena se reinició conservando solo las dos claves.
Tilemap y tileset creados en el mismo run: las cuatro muestras renderizadas fueron RGB (35,115,230), (38,220,80), (190,70,225), (230,190,35). El actor cayó y quedó en y=64.0 sobre ground; la capa props no activó colisión.
El orquestador ejecutó generate_image y edit_sprite contra Meta simulado; inspect_asset, create_tileset, create_tilemap, pack_spritesheet y define_animation escribieron en PostgreSQL/Silo. Phaser cargó los bytes recuperados por los IDs persistidos.

Captura: docs/evidence/issue-36-phaser-animations.png.
