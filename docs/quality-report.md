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
