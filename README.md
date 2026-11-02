# Forja — plataforma de juegos 2D

Forja es una plataforma en construcción para crear juegos web 2D mediante chat. El monorepo incluye Next.js, identidad Clerk, persistencia Drizzle y storage privado S3. El editor conecta el chat con runs y transmite progreso durable por SSE. La ejecución y la preview siguen apagadas por defecto hasta configurar Meta, dominio/TLS y un host Linux dedicado; la generación jugable completa y la publicación siguen pendientes.

Los proyectos privados abren un editor de dos paneles en `/projects/[projectId]`: chat persistido, consentimiento de Meta Contributor y opciones rápidas a la izquierda; iframe privado con navegación a la derecha cuando el gateway está habilitado. Enviar un mensaje lo guarda y encola un run cuando `RUNS_ENABLED=true`. Publish/Share siguen deshabilitados.

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

La versión de Node debe mostrar `v24.x`. Abre <http://localhost:3000>. Sin claves Clerk reales, el sitio público y `/api/health` funcionan, el estado de autenticación se indica en pantalla y las rutas privadas permanecen cerradas.

Para habilitar Clerk, configura manualmente en un entorno local las variables Clerk de `.env.example` con claves de una instancia de desarrollo del operador. Configura `APP_ORIGIN` y `CLERK_AUTHORIZED_PARTIES` con los orígenes exactos de la app; no uses dominios recibidos desde una petición. Los flujos sign-in/sign-up redirigen de forma fija a `/editor`. Nunca compartas ni guardes `CLERK_SECRET_KEY` en Git, issues, logs o respuestas HTTP.

El tema Tokyo Night usa tokens semánticos compartidos por Radix Themes y Clerk. En desarrollo local, `/design-system` muestra una galería con controles, portales y estados accesibles; esa ruta devuelve 404 fuera del modo de desarrollo y usa solo contenido sintético.

Consulta [docs/authentication.md](docs/authentication.md) para límites locales, comportamiento de las APIs y validación con dos usuarios. Las pruebas actuales usan sesiones y proyectos sintéticos; la comprobación E2E con una instancia Clerk real requiere claves y usuarios de prueba del operador.

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

`apps/worker` ejecuta BullMQ aparte de Next. El outbox Postgres garantiza entrega recuperable a Redis; el presupuesto, consumo, eventos y leases con fencing quedan en la base. #16 conecta plan previo, skills, herramientas confinadas y verificación. #17 integra consentimiento explícito, enqueue, cancelación y SSE con replay. La API sigue cerrada con `RUNS_ENABLED=false`; activarla requiere Meta configurado, controlador rootless y host Linux validado. Comandos y operación en [docs/runs-and-queue.md](docs/runs-and-queue.md), [docs/run-events.md](docs/run-events.md) y [docs/agent-loop.md](docs/agent-loop.md); decisiones en [ADR 0003](docs/adr/0003-cola-durable-y-cuotas-atomicas.md) y [ADR 0005](docs/adr/0005-orquestador-agente.md).

## Controlador rootless y herramientas confinadas (issues #12-13)

`apps/sandbox-controller` es un servicio privado separado del worker. Resuelve el proyecto y su owner desde PostgreSQL, autentica servicios con Bearer y usa la API local Docker por socket Unix rootless. Cada proyecto recibe UID, contenedor y volumen local distintos. La red del codigo es interna con gateway aislado, sin puertos publicados; las instalaciones npm pasan por un proxy privado de destinos limitados. `readFile`, `writeFile`, `listFiles`, `installDependencies`, `runCommand`, `startDevServer` y `readLogs` validan entradas y solo usan `/workspace`, el puerto fijo 4173 y lease del controlador. No montes el socket runtime en Compose, web, worker o juegos.

Las herramientas siguen cerradas con `SANDBOX_DRIVER=disabled`. En el host Linux dedicado, monta el filesystem del Docker root como ext4/XFS con `usrquota`/`uquota`, aprovisiona cuotas con `scripts/provision-sandbox-user-quotas.sh`, publica la imagen sandbox fijada por digest y configura Docker Engine 28+ rootless con cgroups v2/systemd. Despues ejecuta `npm run sandbox:host-check`: prueba cuota `ENOSPC`, gateway aislado, DNS/egress, rechazo de symlinks, instalacion exacta con hook malicioso, compilacion fixture, timeout y limite de salida. Windows/Docker Desktop no valida aislamiento rootless de produccion. La instalacion Linux y el driver real aun no se han validado; consulta [docs/sandbox-controller.md](docs/sandbox-controller.md) y [docs/sandbox-tools.md](docs/sandbox-tools.md).

## Capturas del tema Tokyo Night

Para repetir la revisión visual a 390 y 1440 px, inicia `npm run dev` y en otra terminal ejecuta `npx playwright install chromium` (solo la primera vez) y `npm run screenshots:theme`. El script verifica contraste, desbordamiento, foco por teclado, diálogo e hidratación del navegador y guarda las capturas en `docs/screenshots/`. Puedes indicar otra URL local con `THEME_SCREENSHOT_BASE_URL`.

## Comandos disponibles

```sh
npm run dev
npm run infra:config
npm run infra:up
npm run infra:up -- --web
npm run infra:up -- --worker
npm run infra:down
npm run db:migrate
npm run db:seed
npm run test:integration
npm run test:e2e
npm run lint
npm run typecheck
npm test
npm run build
npm run build:worker
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

La issue #3 incorpora el esquema Drizzle, migraciones y adaptador S3 privado. La issue #4 añade Clerk, `proxy.ts` y guards de sesión/owner. La issue #6 añade CRUD privado paginado en `/api/projects`, mensajes en `/api/projects/[projectId]/messages` y las vistas `/projects` y `/projects/[projectId]`. La issue #7 construye el editor de dos paneles, edición del nombre, opciones rápidas y vistas vacías de progreso. Las rutas derivan la identidad de `auth()`; body, query y cabeceras nunca eligen el owner.

Cada mensaje tiene `requestId` idempotente y secuencia por proyecto. Si un reintento repite la clave con el mismo rol/contenido, se devuelve el registro existente; si cambia el contenido, la API responde `409 idempotency_conflict`. Los transcript se sirven en orden de secuencia con cursor y texto plano, sin HTML activo.

Eliminar un proyecto establece `deleted_at` en una transacción, oculta el proyecto y sus recursos, cancela runs activos, marca sandbox/assets/snapshots para limpieza, revoca publicaciones y crea una tarea `project_cleanup_tasks` en estado `queued`. La ruta incrementa también el epoch de preview antes del borrado para revocar sesiones y WebSockets. Todavía no existe un worker de reconciliación; los objetos S3 y volúmenes no se destruyen desde la petición web. `RUNS_ENABLED=false` y `PREVIEW_GATEWAY_ENABLED=false` por defecto, por lo que una entrega local con fixtures no equivale a generación ni preview reales.

Con los servicios locales arriba, `npm run db:migrate` aplica las migraciones SQL de Drizzle y se puede repetir. `npm run db:seed` inserta dos usuarios, proyectos y actividad sintéticos; solo acepta PostgreSQL en loopback y es idempotente. `npm run test:integration` crea recursos temporales y verifica ownership, claves foráneas, paginación, idempotencia, ledger, sandboxes, almacenamiento y eliminación reconciliable de proyectos.

El adaptador de storage usa solo `S3_BUCKET_PRIVATE`, genera claves en servidor, admite objetos de hasta 25 MiB y valida SHA-256 al escribir y leer. El bucket privado de Silo no permite lectura anónima. Las migraciones no se revierten automáticamente; consulta [desarrollo local](docs/local-development.md) antes de ejecutar una reversión destructiva.

El contrato `packages/contracts/src/editor.ts` define estados de run, pasos y verificación, y `packages/contracts/src/events.ts` define los eventos SSE públicos versionados. El editor reconstruye plan, pasos, archivos y verificaciones desde el stream durable; permite reconectar, detener y reintentar. `npm test` cubre contratos, proyección de eventos, ownership y las interacciones principales sin Clerk real ni clave Meta. `npm run test:e2e` comprueba los recorridos de editor con fixtures en Chromium, Firefox y WebKit; no acredita Clerk real, dominio/TLS ni el host Linux dedicado.

## Capacidades planificadas

`dev:gateway` y `build:gateway` ya existen. El gateway resuelve únicamente sandboxes listos desde PostgreSQL, consume grants de un uso en Redis y autoriza cada HTTP/WebSocket; `npm run infra:up -- --preview` activa el perfil solo con claves válidas. El editor monta un iframe con sandbox mínimo, renovación de sesión, navegación por rutas comunicadas y fallback de primer nivel por formulario sin grant en URL. Las versiones guardadas se muestran, pero su restauración espera a #21. Los E2E de navegador usan un fixture; aún faltan dominio wildcard con TLS, cookies del dominio real, host Linux dedicado y un recorrido autenticado con dos cuentas Clerk. Las issues están enumeradas en [docs/ROADMAP.md](docs/ROADMAP.md). La conexión de Clerk está implementada; falta validarla con la instancia real del operador antes de cerrar su issue. El acceso real a Meta se informa por separado del resultado de los tests con fixtures.

## Estructura

- `apps/sandbox-controller`: servicio privado rootless, separado de Next y el worker.
- `apps/web`: Next.js App Router, Clerk, React, Radix Themes y TypeScript estricto.
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

Phaser será el motor predeterminado para juegos generados según la arquitectura definida en [AGENTS.md](AGENTS.md); los procesos de juego no se ejecutan dentro de Next.
