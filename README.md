# Forja — plataforma de juegos 2D

Forja es una plataforma en construcción para crear juegos web 2D mediante chat. El monorepo incluye Next.js, autenticación propia, persistencia Drizzle y storage privado S3. El editor conecta el chat con runs y transmite progreso durable por SSE. Los runs, preview y publicación conservan flags apagados por defecto; Compose ofrece una aceptación local reproducible con Docker Desktop, Caddy, Silo y dominios `*.localhost`.

Los proyectos privados abren un editor de dos paneles en `/projects/[projectId]`: chat persistido, consentimiento de Meta Contributor y opciones rápidas a la izquierda; iframe privado con navegación a la derecha cuando el gateway está habilitado. Enviar un mensaje lo guarda y encola un run cuando `RUNS_ENABLED=true`. Publish/Share aparecen cuando `PUBLISHING_ENABLED=true` y solo sirven builds estáticas verificadas desde un origen de juego separado. Consulta [docs/publications.md](docs/publications.md).

## Requisitos

- Node.js `24.x` (`.nvmrc` y `engines.node` fijan `>=24 <25`).
- npm incluido con Node.js. El lockfile está versionado y las dependencias directas usan versiones exactas.
- Docker Engine con Docker Compose v2 para los servicios locales.

La instalación, los tests unitarios y el build no necesitan credenciales externas. No copies `.env.example` sobre un `.env.local` existente: todos sus valores son placeholders. Docker Compose usa `infra/.env`, generado desde `infra/env.example`; ese archivo está excluido de Git.

## Inicio local

Desde PowerShell o una terminal Linux/macOS, en la raíz del repositorio:

```sh
node --version
npm ci
npm run dev
```

La versión de Node debe mostrar `v24.x`. Abre <http://localhost:3000>. El registro, las sesiones y la protección de rutas usan PostgreSQL; sin una sesión válida las rutas privadas permanecen cerradas.

La autenticación propia no necesita claves de proveedor: inicia Postgres, configura `APP_ORIGIN`, `AUTH_ALLOWED_ORIGINS` y los TTL de sesión de `.env.example`. En desarrollo, el mailer de consola muestra los enlaces de verificación y recuperación. Nunca copies un `.env.local` a Git.

El tema Tokyo Night usa tokens semánticos compartidos por Radix Themes y las vistas propias de autenticación. En desarrollo local, `/design-system` muestra una galería con controles, portales y estados accesibles; esa ruta devuelve 404 fuera del modo de desarrollo y usa solo contenido sintético.

Consulta [docs/authentication.md](docs/authentication.md) para los flujos de alta, verificación, sesiones, recuperación y sus límites. Las pruebas cubren sesiones y ownership con identidades sintéticas; los flujos E2E locales usan el mailer de consola.

Para levantar las dependencias locales:

```sh
npm run infra:config
npm run infra:up
```

Postgres, Redis y S3 quedan ligados solo a loopback. `infra:up` prepara buckets privados y conserva los datos entre reinicios. Para agregar la app web en Compose usa `npm run infra:up -- --web`. Consulta [docs/local-development.md](docs/local-development.md) para puertos, persistencia, comprobaciones y reset explícito.

El endpoint `GET /api/health` solo comprueba que la app web responde. Devuelve `{"status":"ok","service":"web"}` sin consultar servicios externos ni serializar el entorno. No representa readiness de base de datos, cola, Meta o sandbox.

Las issues #8 y #9 añaden configuración de servidor, `npm run meta:smoke` y el adaptador interno `MetaClient` para planes estructurados, streaming de código/tool calls y generación de imágenes. #17 conecta el chat al enqueue y expone progreso seguro a partir de eventos durables; la ejecución real solo se activa con `RUNS_ENABLED=true` y recursos operativos verificados. El smoke carga `.env.local` (ignorado por Git) o variables del proceso, comprueba los tres modelos y envía un prompt sintético; sin `META_API_KEY` falla antes de hacer solicitudes. `--tools` añade solicitudes con uso de tokens y `--image` genera una imagen con cobro separado; revisa los precios vigentes antes de esas opciones. Consulta [docs/meta-api.md](docs/meta-api.md).

La issue #10 añade `@meta-game/skills`: un subconjunto vendorizado en un SHA fijo, catálogo de metadata, router por tarea con presupuesto de 8.000 tokens, guías locales para Phaser 3.90/shooter cenital/testing y verificación de hashes con `npm run skills:verify`. El worker consume el router y persiste los hashes seleccionados por run desde #16. Consulta [docs/skills.md](docs/skills.md).

## Cola durable y runs (issue #11)

`apps/worker` ejecuta BullMQ aparte de Next. El outbox Postgres garantiza entrega recuperable a Redis; el presupuesto, consumo, eventos y leases con fencing quedan en la base. #16 conecta plan previo, skills, herramientas confinadas y verificación. #17 integra consentimiento explícito, enqueue, cancelación y SSE con replay. `RUNS_ENABLED=false` por defecto; habilitarlo requiere Meta configurado y el perfil runtime local validado. Comandos y operación en [docs/runs-and-queue.md](docs/runs-and-queue.md), [docs/run-events.md](docs/run-events.md) y [docs/agent-loop.md](docs/agent-loop.md); decisiones en [ADR 0003](docs/adr/0003-cola-durable-y-cuotas-atomicas.md) y [ADR 0005](docs/adr/0005-orquestador-agente.md).

## Controlador sandbox y herramientas confinadas (issues #12-13)

`apps/sandbox-controller` es un servicio privado separado del worker. Resuelve proyecto y owner desde PostgreSQL, autentica servicios con Bearer y usa la API Docker solo dentro del perfil `runtime`; los sandboxes no reciben el socket. Cada proyecto recibe UID, contenedor y workspace aislados. La red del código es interna con proxy npm limitado, sin puertos publicados. `readFile`, `writeFile`, `listFiles`, `installDependencies`, `runCommand`, `startDevServer` y `readLogs` validan entradas y usan `/workspace`, el puerto 4173 y lease del controlador.

`SANDBOX_DRIVER=disabled` por defecto. `npm run infra:up -- --acceptance` construye el sandbox local, valida Docker Desktop con cgroups v2, workspace tmpfs acotado y UID no root, y arranca controlador, editor, gateway y origen bajo Caddy. El daemon Docker Desktop es rootful; esta prueba no lo presenta como rootless ni valida cuotas de volúmenes XFS/ext4. Consulta [docs/sandbox-controller.md](docs/sandbox-controller.md), [docs/sandbox-tools.md](docs/sandbox-tools.md) y [despliegue interno](docs/deployment.md).
## Capturas del tema Tokyo Night

Para repetir la revisión visual a 390 y 1440 px, inicia `npm run dev` y en otra terminal ejecuta `npx playwright install chromium` (solo la primera vez) y `npm run screenshots:theme`. El script verifica contraste, desbordamiento, foco por teclado, diálogo e hidratación del navegador y guarda las capturas en `docs/screenshots/`. Puedes indicar otra URL local con `THEME_SCREENSHOT_BASE_URL`.

## Comandos disponibles

```sh
npm run dev
npm run infra:config
npm run infra:up
npm run infra:up -- --web
npm run infra:up -- --worker
npm run infra:up -- --publishing
npm run infra:down
npm run db:migrate
npm run db:seed
npm run test:integration
npm run resources:reconcile
npm run test:e2e
npm run test:performance
npm run lint
npm run typecheck
npm test
npm run build
npm run build:worker
npm run build:publishing-origin
npm run dev:publishing-origin
npm run build:controller
npm run sandbox:host-check
npm run start
npm run check:node
npm run screenshots:theme
npm run meta:smoke
npm run meta:smoke -- --tools
npm run meta:smoke -- --image
```

`npm ci` aplica `engine-strict`; también hay una comprobación explícita de Node 24 en la instalación y en los comandos de raíz. CI usa Node 24 y ejecuta instalación, lint, typecheck, tests y build sin claves.

## Persistencia y autorización

La issue #3 incorpora el esquema Drizzle, migraciones y adaptador S3 privado. La issue #29 implementa autenticación propia, `proxy.ts`, sesiones persistentes y guards de owner. La issue #6 añade CRUD privado paginado en `/api/projects`, mensajes en `/api/projects/[projectId]/messages` y las vistas `/projects` y `/projects/[projectId]`. La issue #7 construye el editor de dos paneles, edición del nombre, opciones rápidas y vistas vacías de progreso. Las rutas derivan la identidad de la sesión verificada en servidor; body, query y cabeceras nunca eligen el owner.

Cada mensaje tiene `requestId` idempotente y secuencia por proyecto. Si un reintento repite la clave con el mismo rol/contenido, se devuelve el registro existente; si cambia el contenido, la API responde `409 idempotency_conflict`. Los transcript se sirven en orden de secuencia con cursor y texto plano, sin HTML activo.

Eliminar un proyecto o una cuenta corta el acceso de inmediato y crea tareas privadas de limpieza con leases y trazabilidad. El worker quiesce sandboxes borrados, conserva los volúmenes durante la retención y después borra solo objetos/IDs recuperados de PostgreSQL. Las cuentas propias exigen contraseña, revocan sesiones y scrubbean email/hash antes del borrado asíncrono de proyectos. Las cuotas incluyen proyectos, storage, tokens, imágenes, concurrencia y tiempo; `/projects` muestra uso/reservas y motivos de rechazo. Consulta [docs/resource-lifecycle.md](docs/resource-lifecycle.md). `RESOURCE_LIFECYCLE_ENABLED=false`, `RUNS_ENABLED=false` y `PREVIEW_GATEWAY_ENABLED=false` por defecto: mocks y servicios locales no acreditan un host rootless real.

Con los servicios locales arriba, `npm run db:migrate` aplica las migraciones SQL de Drizzle y se puede repetir. `npm run db:seed` inserta dos usuarios, proyectos y actividad sintéticos; solo acepta PostgreSQL en loopback y es idempotente. `npm run test:integration` crea recursos temporales y verifica ownership, claves foráneas, paginación, idempotencia, ledger, sandboxes, almacenamiento y eliminación reconciliable de proyectos.

El adaptador de storage usa solo `S3_BUCKET_PRIVATE`, genera claves en servidor, admite objetos de hasta 25 MiB y valida SHA-256 al escribir y leer. El bucket privado de Silo no permite lectura anónima. Las migraciones no se revierten automáticamente; consulta [desarrollo local](docs/local-development.md) antes de ejecutar una reversión destructiva.

El contrato `packages/contracts/src/editor.ts` define estados de run, pasos y verificación, y `packages/contracts/src/events.ts` define los eventos SSE públicos versionados. El editor reconstruye plan, pasos, archivos y verificaciones desde el stream durable; permite reconectar, detener y reintentar. `npm test` cubre contratos, proyección de eventos, ownership e interacciones principales sin servicios externos. `npm run test:e2e` comprueba el acceso, dashboard, generación, SSE, preview, versiones, publicación, revocación y fallos con componentes reales y APIs fixture deterministas en Chromium, Firefox y WebKit. Axe bloquea hallazgos graves; `npm run test:performance` registra las mediciones del fixture Chromium. Las suites no hacen llamadas facturables a Meta ni afirman validar el runtime de preview en Compose.

## Plantillas Phaser

`packages/game-templates/phaser/` incluye una plantilla autocontenida Phaser 3.90.0, Vite y TypeScript con lockfile, build estático, assets SVG originales, audio sintetizado y presets jugables de plataformas, puzzle, shooter y RPG top-down. Los presets exponen victoria, derrota y reinicio, con teclado, controles táctiles, pausa y mute. La guía y límites de validación están en [docs/game-template.md](docs/game-template.md).

Desde la raíz se puede validar la plantilla sin claves:

```sh
npm ci --prefix packages/game-templates/phaser --ignore-scripts
npm --prefix packages/game-templates/phaser test
npm run build:game-template
npm run test:e2e:game-templates
```

El E2E de la plantilla valida el canvas, teclado, botón táctil, pause/mute, reinicio, victoria/derrota y solicitudes locales en Chromium, Firefox y WebKit. El build de Vite no requiere conexión de assets externos. Desde #20 el worker materializa la plantilla en workspaces vacíos, verifica test/lint/build y pide al runner aislado que pruebe movimiento antes de declarar `preview.ready`. La aceptación local usa `app.localhost`, `*.preview.localhost` y `*.games.localhost` con TLS interno de Caddy.

## Assets generados con Meta (issue #19)

El worker ofrece `generate_image` para briefs de sprites, fondos, tilesets y UI. Reserva cuota por imagen, solicita el modelo configurado, valida firma/formato/dimensiones/transparencia/grilla, normaliza PNG, genera hoja de contacto y registra procedencia en S3 privado. Copia el PNG al sandbox por una operación binaria de ruta acotada y registra el manifest que Phaser carga. Cada asset queda marcado `pending-in-live-preview` para inspección humana en contexto; los checks no certifican calidad artística ni seams perfectos. Los runs siguen apagados por defecto. Límites, manejo de ambigüedad, checks y dependencias externas están en [docs/generated-assets.md](docs/generated-assets.md).

## Generación y reparación (#20)

El worker normaliza preferencias a `GameSpec`, conserva la especificación del último run exitoso para cambios incrementales y guarda checkpoints privados antes de editar. `npm test`, `npm run lint`, `npm run build`, health check y verificación Playwright dentro del sandbox deben pasar; entonces emite `preview.ready`. Tiene un intento de reparación y restaura el último estado verificable si falla o se cancela. Ver [docs/generation.md](docs/generation.md).

La imagen del sandbox incluye el runner Chromium fijado a Playwright 1.64.1. La aceptación construye localmente para el motor Linux de Docker Desktop y fija el ID de contenido de la imagen en esa ejecución. `RUNS_ENABLED=false` evita llamadas reales a Meta; los fixtures y el smoke de texto no acreditan una generación facturable real.
## Capacidades planificadas

`dev:gateway` y `build:gateway` ya existen. El gateway resuelve únicamente sandboxes listos desde PostgreSQL, consume grants de un uso en Redis y autoriza cada HTTP/WebSocket. El editor monta un iframe con sandbox mínimo, renovación de sesión, navegación por rutas comunicadas y fallback de primer nivel por formulario sin grant en URL. Las versiones verificadas se guardan en S3 privado y pueden restaurarse como una nueva versión; la revisión muestra cambios y verificaciones. La preview de snapshots históricos sin modificar el workspace sigue pendiente. La aceptación de gateway y TLS local se ejecuta con `npm run infra:up -- --acceptance`; consulta [docs/versions.md](docs/versions.md) y [docs/ROADMAP.md](docs/ROADMAP.md). El acceso real a Meta se informa por separado de los tests con fixtures.

## Estructura

- `apps/sandbox-controller`: servicio privado rootless, separado de Next y el worker.
- `apps/web`: Next.js App Router, autenticación propia, React, Radix Themes y TypeScript estricto.
- `apps/web/components/ui`: wrappers Radix reutilizables y galería local del tema.
- `packages/config`: validación de URLs públicas y configuración de infraestructura local.
- `packages/sandbox`: driver rootless, API privada y cliente autenticado para el worker.
- `packages/contracts`: schemas Zod de liveness, errores HTTP, proyectos, progreso del editor y contratos Meta.
- `packages/meta`: `MetaClient`, transporte server-side acotado, replay stateless y smoke opt-in de Meta.
- `packages/skills`: catálogo y router de skills consultivas con hashes upstream fijados y carga por tarea.
- `packages/db`: modelo PostgreSQL/Drizzle y repositorios que requieren identidad verificada.
- `packages/storage`: adaptador S3 privado con claves de servidor, checksum y estados de reconciliación.
- `infra`: Docker Compose, perfiles de desarrollo, ejemplos locales y digest de imágenes.
- `tests`: contratos, interacciones del editor, persistencia y autorización sintética.
- `.github/workflows/ci.yml`: verificación en Node 24, sin secretos.

Phaser es el motor predeterminado para juegos generados según la arquitectura definida en [AGENTS.md](AGENTS.md); los procesos de juego no se ejecutan dentro de Next.


## Operacion y recuperacion local (#26)

La decision del propietario en AGENTS.md define Compose local como desarrollo, staging y aceptacion internos. Las menciones antiguas a VPS, DNS publico o un host Linux dedicado quedan sustituidas por perfiles Docker Desktop, dominios *.localhost y TLS local cuando haga falta. La autenticacion es propia y no depende de Clerk.

Consulta [guia de operacion, metricas, alertas y backup/restore](docs/operations-issue-26.md) y [evidencia del simulacro PostgreSQL + Silo](docs/backup-restore-report.md). La guia documenta logs sanitizados, correlacion requestId/runId, healthchecks, rotacion de claves cifradas y restauracion solo a destinos vacios.

```sh
npm run infra:config
npm run infra:up -- --web --worker
npm run backup:acceptance
npm run backup:create
```

El endpoint de metrics web es `/api/metrics`; los servicios internos mantienen `/livez`, `/readyz` y `/metrics` en la red Compose, sin publicar el puerto 9090.

## Despliegue interno de aceptación (#27)

El staging interno de Docker Compose sirve el editor por `https://app.localhost`, el gateway por `*.preview.localhost` y publicaciones por `*.games.localhost`. Caddy emite certificados autofirmados locales y publica HTTPS solo en loopback. La guía operativa, rollback y matriz están en [despliegue](docs/deployment.md), [rollback](docs/rollback.md) y [verificación](docs/staging-verification.md).

```sh
npm run infra:up -- --acceptance
npm run infra:down
```

El perfil acepta el runtime local y mantiene runs de Meta apagados. La publicación pública y el smoke facturable real de Meta no forman parte de este entorno.