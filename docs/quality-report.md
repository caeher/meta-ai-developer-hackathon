# Informe de calidad E2E (#25)

## Alcance

La suite de navegador monta los componentes de autenticación propia, dashboard, editor, opciones rápidas, preview y publicación reales. El API fixture determinista cubre login exitoso/incorrecto, dos identidades aisladas, enqueue y SSE, reconexión, cuota, errores de Meta/sandbox, snapshots y revocación; no llama a Meta ni ejecuta un sandbox de producto. La autenticación, ownership, Postgres/Redis/Silo y seguridad Docker tienen además suites de integración/seguridad independientes.

Playwright corre el editor en Chromium, Firefox y WebKit; el template Phaser también se prueba en esos tres navegadores. Axe examina autenticación, dashboard, editor, opciones rápidas y juego. Los hallazgos críticos y graves fallan la suite. Las interacciones de teclado y el layout móvil/desktop tienen verificaciones explícitas.

CI usa fixtures sin claves. No se guardan traces, videos, screenshots ni artifacts públicos que puedan contener información privada. El smoke real de Meta se mantiene opt-in y no pertenece a esta suite.

## Evidencia de aceptación local

Aceptación local, 2 de noviembre de 2026 (Windows 11 Pro, Node 24.22.1, Playwright 1.64.1, Compose con motor Docker Linux):

- `npm test`: 36 archivos y 227 pruebas aprobados; 10 archivos/45 pruebas omitidos por gates explícitos de servicios y runtime.
- `npm run test:integration`: 9 archivos y 43 pruebas aprobados contra PostgreSQL, Redis y Silo de Compose; 1 prueba Redis adicional omitida por su gate.
- `npm run test:e2e`: 69 pruebas aprobadas en Chromium, Firefox y WebKit. Incluye autenticación/dashboard/editor/SSE, dos identidades, errores y recuperación, versiones, publicación y revocación.
- `npm run test:e2e:game-templates`: 21 pruebas aprobadas en Chromium, Firefox y WebKit, incluidos controles de teclado/touch y auditoría Axe.
- `npm run test:performance`: aprobada; 515 ms shell, 155 ms primer evento, 559 ms preview, 176 ms recarga y 61 FPS. Ver [presupuestos y perfil](performance.md).
- Axe no reportó violaciones críticas ni graves en autenticación, dashboard, editor, opciones rápidas o controles del juego.
- `npm run lint`, `npm run typecheck`, `npm run build`, `npm run build:worker`, `npm run build:controller`, `npm run build:gateway`, `npm run build:publishing-origin` y `npm run build:game-template` finalizaron correctamente. `npm run infra:config`, `npm run infra:up -- --web --worker` y `npm run infra:down` también; Compose detuvo los contenedores y conservó los volúmenes.

Las suites de navegador usan respuestas API deterministas: no ejecutan llamadas facturables a Meta ni el sandbox de producto. La integración local sí ejercita las dependencias Compose reales. El smoke de Meta es opt-in; `RUNS_ENABLED=false` y `PREVIEW_GATEWAY_ENABLED=false` siguen siendo los defaults documentados.


## Aceptacion local de issue #37 - 3 de noviembre de 2026

El escenario determinista genero un personaje con idle/run y un tilemap con suelo, pared y celda vacia mediante generate_image simulado, inspect_asset, pack_spritesheet, define_animation, create_tileset y create_tilemap. PostgreSQL y Silo conservaron los manifests/bytes; no se llamo a Meta ni se incurrieron cargos.

npm run test:assets:acceptance paso contra Compose: 15 archivos y 53 pruebas de integracion aprobadas, una prueba Redis omitida por su gate, y una prueba Playwright Chromium aprobada. Un contenedor de sandbox aislado ejecuto tests/lint/build de Vite y Phaser 3.90, sirvio los resultados persistidos, comprobo rectangulos del atlas sin solapes/fuera de limites, pivotes, orden y velocidad de animacion, render de tiles, colision de pared/celda vacia y movimiento con teclado. No hubo errores de pagina, warnings Phaser, respuestas fallidas ni solicitudes fuera del origen local. JSON de evidencia: docs/evidence/issue-37-docker-preview.json; se guardo reporte, sin screenshots, videos ni traces.

Validacion adicional: npm test en el runner Compose (303 aprobadas, 47 omitidas por gates; incluye 8 pruebas de sandbox hostil Docker), npm run lint, npm run typecheck, npm run build, npm run build:game-template, y el E2E Chromium de tarjeta durable/reconexion (1 aprobado).

Para la preview el runner usa Vite 7.3.7 y Phaser 3.90.0 fijados en el lockfile y copiados localmente al sandbox; el sandbox tuvo egress deshabilitado. El mount tmpfs del workspace declara exec porque Rollup carga un addon nativo desde alli; /tmp y /run conservan noexec.


Nota de red: el proxy npm respondio HTTP 502 a un intento de instalar desde el sandbox. La aceptacion final uso las dependencias exactas ya instaladas en el runner Compose, verifico sus versiones contra el lockfile y deshabilito egress en el sandbox. Por tanto, esta evidencia valida build/preview/animacion/colision, no una descarga externa de npm.
