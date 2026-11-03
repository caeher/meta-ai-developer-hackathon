# Guía para agentes de código

## Visión y alcance

### Decisión del propietario: monolito y entorno local

La aplicación es un monolito de producto. No se usa VPS, staging remoto, servidor remoto, host Linux dedicado, DNS público ni TLS wildcard real. `infra/compose.yml` es el único entorno interno para desarrollo, staging y aceptación; usa Docker Desktop con motor Linux, Postgres, Redis, Silo y los perfiles locales de la aplicación. El controlador, sandbox, cuotas, egress, gateway, observabilidad y rollback que pida una issue deben implementarse y probarse dentro de Compose en esta máquina. Para preview/publicación se usan dominios `*.localhost`; si hace falta HTTPS, se usa TLS local autofirmado.

Esta decisión sustituye las referencias antiguas de este archivo y de los ADR a VPS, staging remoto o host Linux dedicado. No declarar una issue bloqueada por el despliegue público: ese despliegue final lo hará el propietario y no forma parte del criterio de terminado. Marcar `ESTADO: COMPLETA` cuando el código y las pruebas aplicables, incluidas las de Docker local, pasen; marcar `ESTADO: PARCIAL` solo si falta código o fallan pruebas, lint, typecheck o build. No afirmar que una capa está validada si solo pasó un mock.

### Estado actual (2 de noviembre de 2026)

La issue #29 sustituye la integración de identidad externa por autenticación propia: registro e inicio con correo y contraseña, verificación y recuperación por tokens de un solo uso, sesiones opacas en PostgreSQL, bloqueo progresivo y pantallas Radix Tokyo Night. Los endpoints privados derivan `userId` de la sesión verificada y mantienen ownership junto al dato; consulta [docs/authentication.md](docs/authentication.md) y [docs/adr/0004-auth-propia.md](docs/adr/0004-auth-propia.md). La issue #6 añade CRUD privado paginado, transcript persistente idempotente y eliminación lógica reconciliable; #7 presenta el editor de dos paneles y opciones rápidas; #16 y #17 conectan planificación, herramientas tipadas, verificación y SSE durable. `RUNS_ENABLED=false` y la preview siguen apagados por defecto hasta que sus perfiles y pruebas locales de Compose estén listos.

Estado local de issue #17 (2 de noviembre de 2026): la API SSE privada proyecta `runEvents` a eventos versionados y allowlisted, acepta `Last-Event-ID`, pagina el replay, limita el buffer, emite heartbeat y vuelve a comprobar la sesión/ownership durante la conexión. El editor recupera el último run, repone plan/pasos/archivos/verificaciones desde eventos durables, reconecta sin duplicar, permite detener y reintentar con claves idempotentes, y solo renueva la preview ante `preview.ready` posterior al health check del servidor. El formulario exige confirmación explícita de mayoría de edad y términos Contributor. `RUNS_ENABLED=false` y `PREVIEW_GATEWAY_ENABLED=false`; falta validar estos recorridos en el Compose local. El mailer productivo es un adaptador externo opcional, no una dependencia de staging remoto.

Estado local de issue #18 (2 de noviembre de 2026): `packages/game-templates/phaser/` fija Phaser 3.90.0, Node 24, Vite, TypeScript y lockfile, y contiene presets Phaser jugables de plataformas, puzzle, shooter y RPG top-down con assets locales originales, audio sintetizado, teclado/touch, pausa, mute y reinicio. Vitest cubre los reducers de victoria/derrota/reinicio y Playwright verifica render, input, assets, puzzle/shooter, ciclo de escena y consola. El hook `window.__GAME_TEST__` es de solo lectura y solo se incluye en desarrollo. El worker materializa la plantilla en workspaces vacíos mediante herramientas tipadas, instala las versiones exactas sin lifecycle scripts, ejecuta test/build e inicia Vite tras comprobar su health check; un marcador recuperable evita resembrar proyectos personalizados. Sigue pendiente validar sandbox y gateway/HMR desde el Compose local; `SANDBOX_DRIVER=disabled` y `PREVIEW_GATEWAY_ENABLED=false` continúan por defecto.

Lee primero [docs/PROJECT_BRIEF.md](docs/PROJECT_BRIEF.md). Construimos una plataforma tipo v0 para crear y modificar juegos web 2D mediante chat: plan visible, herramientas, archivos cambiados, verificaciones y preview privada en vivo. El editor tiene chat a la izquierda, preview a la derecha y header con proyecto, avatar, versiones y Publish/Share. Incluye opciones rápidas para género, arte, controles, niveles, enemigos, assets y sonido.

El commit inicial contenía planificación. `main` ya incluye el monorepo, los servicios locales Postgres/Redis/S3 y la persistencia Drizzle con repositorios de owner y storage privado de la issue #3. Las capacidades posteriores siguen siendo objetivos hasta implementarlas y comprobarlas. Mantén ejecutable lo que ya exista y no declares disponible un comando o integración sin verificarlo. El orden está en [docs/ROADMAP.md](docs/ROADMAP.md) y en las issues de `caeher/meta-ai-developer-hackathon`.

Estado local de issue #13 (2 de noviembre de 2026): packages/sandbox ofrece readFile, writeFile, listFiles, instalacion npm exacta sin lifecycle scripts, runCommand tipado y un servidor Vite fijo con lease/health/logs. El helper nativo opera relativo a descriptores de /workspace, rechaza symlinks y archivos especiales, y escribe mediante rename atomico. Cada proyecto usa una red interna IPv4/IPv6 con gateway isolated de Docker Engine 28; solo un proxy de confianza conectado a una red egress comun alcanza npm, con destinos DNS publicos fijados, redirects limitados y rutas GET/HEAD permitidas. El driver y el host-check verifican la red y las herramientas desde un contenedor real. `SANDBOX_DRIVER=disabled` permanece por defecto; falta integrar y pasar preflight, egress, instalación y cuota dentro del Compose local.

Estado local de issue #14 (2 de noviembre de 2026): el endpoint emite grants RS256 de 60 s tras comprobar una sesión propia válida, owner y servidor listo; Redis consume jti y crea sesión atómicamente. El gateway autoriza HTTP/WebSocket por Host, owner, lease, epoch y cookie particionada; el proxy egress apunta al Vite fijo del sandbox y elimina cookies/credenciales. `PREVIEW_GATEWAY_ENABLED=false` por defecto. Falta integrar el gateway y validar las cookies en navegadores contra el Compose local; se usan `*.localhost` y TLS autofirmado si el test requiere HTTPS. El iframe corresponde a #15. Ver [docs/adr/002-preview-auth.md](docs/adr/002-preview-auth.md).

Estado local de issue #15 (2 de noviembre de 2026): el editor canjea grants efímeros, comprueba la cookie particionada, presenta estados de preview y permite renovación explícita. El iframe restringe permisos y navegación; la pestaña nueva usa un formulario de primer nivel con `noopener`, grant en el body y sin token en URL. Atrás/adelante solo recorren rutas locales aceptadas por origen/fuente/schema; no se lee el DOM cross-origin. El selector lista snapshots privados desde #21; el resumen y la restauración están conectados, pero una versión histórica todavía no se puede servir como preview jugable aislada. Los E2E Chromium/Firefox/WebKit usan fixtures. Falta validar en el Compose local con `*.localhost` y TLS autofirmado cuando corresponda; la feature permanece apagada por defecto. Ver [docs/adr/002-preview-auth.md](docs/adr/002-preview-auth.md).

## Decisiones de arquitectura

Estado local de issue #12 (2 de noviembre de 2026): `packages/sandbox` y `apps/sandbox-controller` resuelven owner/proyecto en PostgreSQL, usan Docker rootless, UID interior unico, volumen con cuota dura, rootfs read-only, cgroups y TTL con reaper. `ESTADO: PARCIAL`: falta integrar el controlador y demostrar límites/cuota con Docker Desktop desde el Compose local. No se requiere ni se usará un host Linux remoto.

Estado local de issue #9 (2 de noviembre de 2026): `MetaClient` ofrece `plan`, `streamCode`, `generateImage` y `smokeTest` con contratos Zod compartidos. Responses usa JSON Schema para el plan, SSE para texto/argumentos completos y replay stateless con razonamiento solo cifrado; únicamente argumentos validados de un response completado se emiten como tool calls. `generateImage` limita base64 a 20 MiB y acepta PNG/JPEG/WebP con dimensiones acotadas. Los `POST` no se reintentan automáticamente porque Meta no documenta idempotencia; timeout, desconexión o 5xx quedan marcados ambiguos. `GET /models` se reintenta como máximo dos veces con jitter y `Retry-After`. Fixtures y pruebas son offline; el chat y la ejecución de herramientas siguen deshabilitados.

Estado de la issue #8 (2 de noviembre de 2026): `packages/meta` valida la clave y la allowlist de Meta, limita timeouts y ofrece `npm run meta:smoke`. El smoke real se verificó en Node 24.22.1 con respuestas exitosas para los modelos configurados y texto sintético; no se guardaron clave ni ID completo. Las pruebas offline usan respuestas mock. `--tools` y `--image` son opt-in por uso facturable. El smoke no conecta Meta al chat ni habilita generación. `GET /v1/models` muestra modelos habilitados para el equipo; la disponibilidad depende de cuenta, facturación y región. Contributor no está disponible para equipos con ZDR, y las restricciones regionales y de elegibilidad deben comprobarse con las políticas oficiales antes de integrar contenido de usuarios.

- **Node 24 en todos los proyectos Node**, incluidos plantillas, imágenes Docker, CI y servicios. `.nvmrc`: `24`; `engines.node`: `>=24 <25`; npm workspaces con `package-lock.json` versionado y `npm ci`. Comprobar compatibilidad y fijar versiones de dependencias al implementar, sin actualizar majors implícitamente.
- **Next.js App Router + TypeScript estricto** para la aplicación y API de control. Usar Server Components por defecto y Client Components para interacción. **Radix Themes/Primitives** para las vistas; el producto mantiene sus propias pantallas de autenticación. El canvas del juego pertenece a Phaser.
- **PostgreSQL + Drizzle**: relaciones, transacciones, migraciones SQL auditables y tipado cercano al esquema. **Redis + BullMQ** para trabajos durables, locks y límites atómicos. **S3 compatible** para assets y snapshots privados; Silo, fork compatible con MinIO, es el storage interno de Docker Compose para desarrollo y aceptación. La base es la fuente de verdad, no el disco temporal ni Redis.
- **Worker Node separado** de las peticiones Next: orquesta Meta, reserva cuotas y ejecuta herramientas mediante un servicio de sandbox. **SSE** para eventos durables con cursor y reconexión. Los procesos del juego nunca corren en el proceso de Next ni en el worker de confianza.
- **Phaser 3**, con baseline de skills 3.90, TypeScript y Vite para los juegos generados. Ofrece escenas, carga de assets, input, audio y Arcade Physics con render WebGL/Canvas sin toolchain nativo. Fijar la versión compatible, no instalar una major distinta automáticamente. Frente a PixiJS reduce las piezas de gameplay a integrar; frente a Godot evita exportaciones y herramientas nativas. El game loop usa `Scene.update(time, delta)` y física del motor.
- **Un sandbox por `(userId, projectId)`**, con un único escritor por proyecto y versiones independientes. El controlador y los sandboxes corren en Docker Compose local; el código no depende de un host remoto. Mantener UID no root, capacidades limitadas, cgroups, red privada, cuotas medibles y checks de ownership.
- **Gateway Node propio**, delante de los puertos privados del sandbox, dentro de Compose. Resuelve el destino desde el registro interno autorizado. Nunca acepta una URL, host interno o puerto arbitrario enviado por el usuario. Para browser preview se usan `*.localhost` y, si se necesita, Caddy con CA local; no se configura DNS/TLS wildcard público.
- La aplicación, las previews y los juegos publicados usan orígenes distintos; preferir dominios registrables separados para ejecución no confiable. Preview siempre privada. Publish crea un artefacto estático inmutable opt-in y Share comparte únicamente ese artefacto.

## Estructura objetivo

```text
apps/web/                  # Next: app/, components/, server/, styles/, proxy.ts
apps/worker/               # Orquestación, jobs, SSE event persistence, cuotas
apps/preview-gateway/      # Autorización, proxy HTTP y WebSocket
apps/publishing-origin/   # Origen público separado para builds estáticas publicadas
apps/sandbox-controller/   # API privada y driver rootless, nunca expuesto al navegador
packages/config/          # Validación de entorno por servicio, TypeScript/ESLint
packages/contracts/       # Zod: API, herramientas, plan, eventos, estados
packages/db/              # Drizzle schema, migrations, consultas con owner
packages/meta/            # MetaClient, transporte, errores y fixtures
packages/skills/          # Catálogo, selección y presupuesto de contexto
packages/sandbox/         # Contratos del driver, filesystem y ejecución restringida
packages/preview/         # Firma/verificación RS256 y store Redis para grants, epochs y sesiones
packages/storage/         # Assets, snapshots y publicaciones con ownership
packages/game-templates/  # Phaser + Vite: escenas, controles, audio, pruebas
vendor/gamedev-skills/    # Subconjunto revisado y fijado; LICENSE y NOTICE
infra/                    # Compose, imágenes, proxy, egress y políticas Linux
scripts/                  # Smoke tests y comprobaciones reproducibles
tests/                    # Integración, E2E, aislamiento y fixtures hostiles
docs/                     # Brief, roadmap, ADRs, operación y demo
```

No guardar workspaces generados, buckets, logs, cachés ni credenciales en Git. Los sandboxes usan volúmenes propios creados por el runtime; ninguna carpeta del host se monta en los juegos.

## Meta: contrato verificado y configuración

Investigación verificada el **2 de noviembre de 2026**; volver a contrastar las fuentes oficiales al implementar. Base oficial: `https://api.meta.ai/v1`; endpoint seleccionado `POST /v1/responses`. Para planificación y código, usar `muse-spark-1.3-contributor`; para imágenes la documentación lista `muse-image-1.0`, sin variante Contributor documentada. No inventar un sufijo Contributor para imagen ni sustituir Meta con otro proveedor. La excepción de imagen debe verse en la configuración y medición de uso. La política geográfica vigente incluye restricciones de territorio y de modelo; a esta fecha Muse Image no se ofrece en India.

La documentación llama `MODEL_API_KEY` a su variable; este proyecto exige **`META_API_KEY`**. `MetaClient` inyecta su valor al transporte servidor mediante Bearer; no hace falta duplicar la credencial. `META_MODEL_PLAN`, `META_MODEL_CODE` y `META_MODEL_IMAGE` son independientes. `META_BASE_URL` se valida contra la allowlist oficial; cambios solo mediante configuración administrativa, nunca por prompt.

`MetaClient` expone `plan`, `streamCode`, `generateImage` y `smokeTest` con tipos internos estables. Solo el adaptador conoce los payloads del proveedor, `function_call`/`function_call_output`, replay, cancelación, errores y datos de imagen. Validar schemas, límites, timeouts, backoff con jitter y `Retry-After`; no reintentar efectos o cobros ambiguos sin idempotencia/reconciliación. Guardar request IDs y uso, sin headers ni prompts completos en logs. No mostrar razonamiento privado: el plan visible es una salida estructurada deliberada.

Contributor puede utilizar contenido para entrenamiento y prohíbe entradas personales/confidenciales; el producto debe informar esta condición antes del envío, bloquear secretos y datos sensibles detectables y limitarse a creaciones no confidenciales. No enviar emails, sesiones, IDs de identidad ni `.env` al modelo. No basta un aviso para garantizar filtrado; documentar los límites y bloquear los casos incompatibles. El servicio exige usuarios adultos y política de privacidad según su documentación. Los equipos con Zero Data Retention no pueden usar variantes Contributor. No habilitar modelos Standard automáticamente ante fallos ni ocultar fallos con respuestas simuladas. Los fixtures deben identificarse como fixtures. La conexión real requiere una clave del operador; nunca inventar un resultado exitoso ni solicitar pegarla en issues/chat.

Variables objetivo, con placeholders en `.env.example` y validación por servicio:

- Aplicación/auth: `APP_ORIGIN`, `NEXT_PUBLIC_APP_URL`, `AUTH_ALLOWED_ORIGINS`, `AUTH_SECRET`, `SESSION_TTL_SECONDS`, `SESSION_ABSOLUTE_TTL_SECONDS`.
- Datos: `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_PRIVATE`, `S3_BUCKET_PUBLIC`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
- Meta: `META_API_KEY`, `META_BASE_URL`, `META_MODEL_PLAN`, `META_MODEL_CODE`, `META_MODEL_IMAGE`, `META_TIMEOUT_MS`.
- Ejecución: `SANDBOX_CONTROLLER_URL`, `SANDBOX_CONTROLLER_TOKEN`, `SANDBOX_DRIVER`, `SANDBOX_IMAGE`, `SANDBOX_CPU_LIMIT`, `SANDBOX_MEMORY_MB`, `SANDBOX_DISK_MB`, `SANDBOX_PIDS_LIMIT`, `SANDBOX_COMMAND_TIMEOUT_MS`, `SANDBOX_IDLE_TTL_SECONDS`, `SANDBOX_EGRESS_ALLOWLIST`.
- Preview: `PREVIEW_BASE_DOMAIN`, `PREVIEW_GATEWAY_ENABLED`, `PREVIEW_TOKEN_KEY_ID`, `PREVIEW_TOKEN_PRIVATE_KEY`, `PREVIEW_TOKEN_PUBLIC_KEYS`, `PREVIEW_TOKEN_TTL_SECONDS`, `PREVIEW_SESSION_TTL_SECONDS`, `PUBLISH_BASE_DOMAIN`.
- Publicación: `PUBLISHING_ENABLED`, `PUBLISHING_ORIGIN_PORT`, `PUBLISH_READ_DATABASE_URL`, `PUBLISH_S3_ACCESS_KEY_ID`, `PUBLISH_S3_SECRET_ACCESS_KEY`, `PUBLISH_READ_ACCESS_KEY_ID`, `PUBLISH_READ_SECRET_ACCESS_KEY`. El bucket publicado sigue privado: worker puede escribir/borrar y el origen de juegos solo leer; no dar credenciales administrativas del bucket en producción.
- Uso/operación: `USER_MAX_CONCURRENT_JOBS`, `PROJECT_MAX_RUN_STEPS`, `RUN_MAX_TOKENS`, `USER_DAILY_TOKEN_LIMIT`, `USER_DAILY_IMAGE_LIMIT`, `USER_MAX_STORAGE_MB`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL`.

Solo URLs públicas llevan `NEXT_PUBLIC_`; nunca se publica una credencial de sesión. No pasar un `.env` completo a servicios ni contenedores; dar únicamente variables mínimas de cada uno. El juego recibe exclusivamente configuración pública de ejecución.

## Skills del agente de juegos

Fuente: [gamedev-skills/awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills), commit revisado `19d93f97c9c1ea0f8b306e77aa81e0d3e352d3e9` (Apache-2.0). La integración posterior importa un subconjunto auditado conservando `LICENSE`, `NOTICE`, atribuciones, rutas originales y un manifiesto con SHA/hash de cada archivo; no descargar `main` en runtime ni ejecutar scripts de instalación externos automáticamente.

Estado local de issue #10 (2 de noviembre de 2026): ese subconjunto y su router están implementados en `vendor/gamedev-skills/` y `packages/skills/`; `npm run skills:verify` comprueba commit, archivos, referencias y hashes. El router lee primero metadata, selecciona un género como máximo y carga cuerpos/referencias permitidos hasta 8.000 tokens estimados. La fuente Phaser upstream apunta a 4.2, así que el baseline 3.90 usa las adaptaciones locales de `packages/skills/local/`. Desde #16 el worker selecciona skills por run y persiste sus IDs, hashes y consumo estimado como evento durable; ese contexto es consultivo y no cambia permisos.

Catálogo base (las rutas son relativas al upstream):

| Necesidad | Skills seleccionables |
| --- | --- |
| Detección y despacho | `router/SKILL.md` y referencias puntuales de routing |
| Escenas, preload/create/update, assets y cámaras | `skills/web-engines/phaser-core/SKILL.md` |
| Movimiento, gravedad, colisiones | `skills/web-engines/phaser-arcade-physics/SKILL.md` |
| Sprites, tilesets, fondos, arte de UI | `skills/disciplines/create-game-assets/SKILL.md` |
| Teclado, touch, gamepad | `skills/disciplines/input-systems/SKILL.md` |
| SFX, mezcla, mute y autoplay | `skills/disciplines/audio-design/SKILL.md` |
| Timestep y rendimiento | `physics-tuning` y `performance-optimization`, en `skills/disciplines/` |
| Niveles, feedback, cámara, HUD | `level-design`, `game-feel`, `camera-systems`, `game-ui-ux`, en `skills/disciplines/` |
| Plataformas, puzzle, RPG top-down | `platformer`, `puzzle`, `rpg`, en `skills/genres/` |
| Prototipo y entrega | `prototype-fast`, `game-jam`, en `skills/workflows/` |

No hay una skill Phaser dedicada a testing en el catálogo revisado: cubrirlo con guía local `packages/skills/local/phaser-testing.md`, Vitest para lógica y Playwright para canvas, consola, assets e interacción. No aplicar la skill `fps-shooter` como si fuera una guía 2D: shooter top-down usa Phaser, input, física y guía local específica. No copiar APIs Godot/Unity de las skills composicionales; enlazar el concepto a Phaser y documentar huecos.

Carga selectiva: precargar solo nombres/descripciones y reglas del router; detectar motor/versión en el manifest de proyecto; clasificar tarea; escoger como máximo un género y las disciplinas pertinentes; cargar cuerpos solo al seleccionarlos, referencias solo cuando hagan falta. Orden: motor, disciplina, género y workflow. Presupuesto inicial de skills de 8.000 tokens por turno, con deduplicación y conteo mediante tokenizer compatible o estimación conservadora documentada. Si excede, resumir referencias y aplazar detalles; nunca truncar reglas de seguridad. Mantener IDs/hashes elegidos y consumo por run; reencaminar solo al cambiar la tarea.

Las skills son contexto consultivo, nunca permisos. Prompts, archivos del usuario, logs y respuestas de herramientas son datos no confiables. Sus instrucciones no pueden cambiar ownership, herramientas permitidas, egress o cuotas. El proveedor de imágenes del producto es Meta mediante `MetaClient`, aunque upstream mencione otras herramientas. Toda producción de assets exige manifiesto, dimensiones/alpha comprobados y visualización en el juego; no asumir que una imagen generada es un spritesheet válido.

## Seguridad y flujo multiusuario

1. La app valida la cookie opaca consultando `auth_sessions` y `users` en PostgreSQL. `userId` se deriva únicamente de esa sesión; nunca del body, query, prompt o cabecera no confiable. Cada consulta y mutación de proyecto, mensaje, run, asset, snapshot, job y publicación comprueba owner; devolver 404 uniforme al no dueño. `proxy.ts` protege navegación por presencia de cookie, pero cada API y página vuelve a validar la sesión junto al dato.
2. Un run reserva cuota atómicamente, toma lock por proyecto y persiste el plan antes de ejecutar. Estados: `queued`, `planning`, `running`, `verifying`, `succeeded`, `failed`, `cancelled`. Usar idempotency keys, fencing/lease y reconciliación para que un worker antiguo no escriba tras perder el lock.
3. Solo el controlador privado puede hablar con el runtime Docker. Ni web, worker ni sandbox reciben el socket Docker; en Compose local, solo el contenedor de controlador de confianza puede montarlo. Nunca exponer el daemon por TCP. Compose es dueño del ciclo de vida; un driver falso sirve para pruebas de contrato, nunca como aislamiento real de demo.
4. Cada sandbox tiene UID sin privilegios, namespaces y workspace privados, rootfs de solo lectura, límites de disco y cgroups comprobados dentro de Docker local, tmpfs acotado para `/tmp` y `/run`, capabilities eliminadas, `no-new-privileges`, seccomp y controles LSM cuando existan. Sin host PID/network/IPC, dispositivos, montajes del host, sockets del runtime ni secretos de plataforma. Límites iniciales configurables: 1 CPU, 1.024 MiB RAM, 2.048 MiB disco, 128 procesos, comando 60 s e inactividad 15 min. Verificar que cada límite se aplique desde los contenedores de prueba; si no, fallar cerrado. El sandbox comparte el kernel Linux de Docker Desktop; registrar el riesgo y no afirmar aislamiento más fuerte del validado.
5. Red denegada por defecto. Instalaciones pasan por un proxy/registro npm permitido, con métodos y destinos restringidos; validar dependencias/versiones y usar instalación sin lifecycle scripts por defecto. Rechazar git/URLs/tarballs arbitrarios. No exponer red de base, Redis, storage, Meta ni controlador. Bloquear localhost, redes privadas, metadata y IPv6 equivalentes, redirects y DNS rebinding en toda descarga/proxy. Las políticas de red deben probarse desde código arbitrario dentro del contenedor, no solo desde herramientas.
6. Herramientas tipadas `readFile`, `writeFile`, `listFiles`, `installDependencies`, `runCommand`, `startDevServer`, `readLogs`, `generateImage`. Resolver rutas contra la raíz del workspace y negar escapes por `..`, symlinks/hardlinks y archivos especiales. Ejecutar argv mediante spawn sin shell, cwd fijo y comandos/flags permitidos. La allowlist no vuelve confiable al código ejecutado; la frontera es el sandbox. Limitar salida, tiempo, tamaño de archivos e imágenes y número de pasos. Separar herramientas de instalación, verificación y server.
7. Preview: la app verifica la sesión propia y ownership antes de emitir un grant de un solo uso (TTL de 60 s). El gateway lo consume y crea una sesión corta ligada a `userId`, `projectId`, `aud`, `exp`, `jti` y epoch revocable. Cookie host-only, Secure, HttpOnly, SameSite=None y Partitioned, sin Domain; CORS solo acepta APP_ORIGIN y el grant viaja en el body, nunca en URL; autorizar cada HTTP/asset y cada upgrade WebSocket, y cerrar sockets al expirar/revocar. No incluir bearer duradero en URL, referers o logs. Sin caché compartida; `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`; rotar claves. Un grant es credencial: no compartir la URL privada.
8. El iframe de origen aislado permite scripts y, solo si Phaser/Vite/HMR lo requiere y se valida, `allow-same-origin`; nunca navegación superior, popups, formularios, descargas ni permisos innecesarios. No ejecutar en el origen de la app. Definir CSP por servicio, `frame-ancestors` limitado a la app, `connect-src` de preview restringido al gateway, Permissions-Policy y `nosniff`. Probar cookies en navegadores que bloquean terceros; si se usa partición o handshake top-level, mantener autenticación y no relajar cookies a todo el dominio. Validar `postMessage` por origen exacto, source y schema; el iframe no elige qué URL carga el padre.
9. S3 privado usa prefijos resueltos por servidor con owner y URLs efímeras solo tras autorizar. Snapshots excluyen secretos, node_modules y sockets; rechazar zip-slip, links y bombas de descompresión al restaurar. Publicar solo build estático verificado, sin fuentes privadas, sourcemaps ni credenciales; revocar/eliminar sin abrir nunca el dev server al público.
10. Limpieza respeta leases activos y borra únicamente IDs/volúmenes administrados; persiste snapshot antes de destruir y permite recuperación. Cuotas cubren tokens, imágenes, concurrencia, almacenamiento, procesos y tiempo. Logs redactados, retención finita y métricas con IDs opacos; no almacenar contenido confidencial ni IDs de identidad en telemetría enviada a Meta.

## Tema, convenciones y pruebas

Tokens Tokyo Night centralizados en `apps/web/styles/tokens.css`: fondo `#1a1b26`, superficie `#24283b`, texto `#c0caf5`, azul `#7aa2f7`, morado `#bb9af7`, cian `#7dcfff`, verde `#9ece6a`, naranja `#ff9e64`, rojo `#f7768e`. Mapear escalas/acento/grises/foco de Radix; no pasar hex arbitrarios a `accentColor`. Cubrir portales y estados hover/focus/disabled/error. Comprobar contraste, teclado, lectores de pantalla y paneles responsive. Controles e información nunca dependen solo del color.

Los wrappers de Radix viven en `apps/web/components/ui/`; la galería `/design-system` solo existe en modo desarrollo, usa contenido sintético y queda bloqueada en producción.

Documentación e issues en español; identificadores, código, eventos y variables en inglés. Validación Zod en fronteras; módulos de secretos `server-only`; nunca importar control de sandbox desde bundles del cliente. Migraciones aditivas y reversión explícita; paginar listas y limitar entradas. No introducir dependencias ni servicios externos sin necesidad documentada.

Comandos objetivo desde raíz, introducidos por la issue correspondiente:

```sh
node --version                 # v24.x
npm ci
npm run dev                    # web; el worker corre separado; gateway privado implementado en #14
npm run dev:worker
npm run build:worker
npm run dev:gateway
docker compose -f infra/compose.yml up -d
npm run infra:config
npm run infra:up                 # Postgres, Redis y storage S3 local
npm run infra:up -- --web        # agrega el perfil web existente
npm run infra:up -- --worker     # agrega el perfil del worker existente
npm run infra:down               # conserva volúmenes
npm run db:migrate
npm run db:seed                 # datos sintéticos, nunca prod
npm run lint
npm run typecheck
npm test                       # unitarias/contratos sin red ni cobros
npm run build
npm run test:integration        # Postgres/Redis/S3 de pruebas
npm run test:e2e                # Playwright Chromium/Firefox/WebKit con fixtures; el proveedor de correo productivo sigue pendiente
npm run test:security:offline   # regresiones de ownership, preview, storage, filesystem y egress
npm run test:security           # suite offline y runtime Docker local desechable
npm run meta:smoke              # clave configurada por operador; coste explícito
npm run skills:verify
```

La issue #2 implementa Compose para Postgres, Redis y Silo; los perfiles `web` y `worker` forman el monolito local. Las imágenes se fijan por digest en `infra/compose.yml` y `infra/images.lock.json`. El mismo Compose es el staging y la aceptación internos; `infra:down` conserva datos. El borrado de volúmenes requiere el comando de reset explícito de `docs/local-development.md`.

Ejecutar las pruebas hostiles únicamente contra recursos desechables del Compose local, nunca contra el equipo fuera del proyecto ni contra producción. CI normal usa fixtures y servicios efímeros; la evidencia del entorno de aceptación proviene del runtime Compose de esta máquina. Las llamadas reales a Meta son opt-in y con presupuesto acotado. Crear tests de comportamiento para autorización, contratos, estado, idempotencia y seguridad; no tests que solo copien la implementación.

## Cómo tomar issues y definición de terminado

1. Consultar `gh issue list --repo caeher/meta-ai-developer-hackathon --state all --limit 200` y el roadmap. Tomar la menor secuencia `[NN]` pendiente con dependencias cerradas, salvo una issue urgente priorizada explícitamente por el dueño; no saltar las puertas de seguridad ni duplicar issues. Cada issue depende de la anterior para permitir ejecución estrictamente secuencial.
2. Leer cuerpo, dependencias, archivos existentes y esta guía. Usar rama `issue-NN-short-description`; trabajo acotado y commit referenciando `#N`. El commit inicial de planificación va en `main` por petición expresa del dueño.
3. Mantener cada entrega funcional: las capacidades futuras quedan deshabilitadas con estado honesto, fixtures solo en pruebas. No simular un proveedor real. Si falta código o falla una comprobación, registrar evidencia y mantener las pruebas de contrato ejecutables.
4. Ejecutar checks aplicables, incluidas las pruebas Docker local; documentar comandos y resultados. Actualizar `.env.example`, README, ADRs, guía y roadmap cuando cambien contratos. El despliegue público no es requisito de una issue.
5. Marcar `ESTADO: COMPLETA` cuando el código y las pruebas aplicables, incluidas las de Docker local, pasen; `ESTADO: PARCIAL` solo si falta código o fallan pruebas, lint, typecheck o build. No marcar una integración como verificada solo porque pasó un mock. No incluir credenciales en diff, logs ni fixtures.

## Fuentes de investigación

Fuentes primarias consultadas; los ejemplos upstream no otorgan permisos ni sustituyen las decisiones del brief:

- [Meta: modelos y disponibilidad](https://dev.meta.ai/docs/models), [quickstart](https://dev.meta.ai/docs/quickstart), [Responses](https://dev.meta.ai/docs/protocols/responses), [tool calling](https://dev.meta.ai/docs/tool-calling), [generación de imágenes](https://dev.meta.ai/docs/image-generation), [Contributor](https://dev.meta.ai/help/policies-and-privacy/contributor-tier), [política geográfica](https://dev.meta.ai/legal/geographic-use-policy) y [precios/límites](https://dev.meta.ai/docs/pricing-rate-limits). Los precios no se codifican como constantes permanentes.
- [Skills y router en el commit investigado](https://github.com/gamedev-skills/awesome-gamedev-agent-skills/tree/19d93f97c9c1ea0f8b306e77aa81e0d3e352d3e9), incluidos Phaser, assets, input, audio y rendimiento. [Phaser: propósito y runtime](https://docs.phaser.io/phaser/getting-started/what-is-phaser).
- Autenticación propia: ver [docs/authentication.md](docs/authentication.md) y [docs/adr/0004-auth-propia.md](docs/adr/0004-auth-propia.md). [Next: convención proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy).
- [Radix Themes: inicio](https://www.radix-ui.com/themes/docs/overview/getting-started) y [color/tokens](https://www.radix-ui.com/themes/docs/theme/color).
- [Docker rootless](https://docs.docker.com/engine/security/rootless/) y [seccomp](https://docs.docker.com/engine/security/seccomp/). La política concreta de red, cuotas y preview es una decisión del proyecto que debe demostrarse mediante pruebas.

Estado local de issue #19 (2 de noviembre de 2026): `generate_image` usa el modelo de imagen configurado, reserva cuota en PostgreSQL antes del POST y no repite requests ambiguos. El pipeline valida firma/MIME, límites, alpha y grillas; normaliza PNG, crea hojas de contacto, mide seams 3×3 como heurística, guarda PNG/metadata en S3 privado y registra el manifest que Phaser carga con `write_binary_file` limitado. Una llamada real a Meta produjo un PNG 2048×1152 que el pipeline normalizó; Phaser lo cargó desde un manifest local y devolvió HTTP 200. La inspección usó un render temporal de QA detrás del nivel, sin cambios permanentes al template; el asset no se guardó con el worker en S3 ni vino de un run privado. `visualReview` sigue pendiente hasta verificarlo desde la preview privada del proyecto. Las pruebas offline cubren cuota, errores ambiguos y ownership con identidades fixture; falta un recorrido E2E web con dos cuentas, S3 y preview dentro del Compose local. `RUNS_ENABLED=false`. Ver [docs/generated-assets.md](docs/generated-assets.md).


Estado local de issue #20 (2 de noviembre de 2026): el worker normaliza GameSpec, conserva la última configuración exitosa por proyecto, guarda checkpoints privados verificables, repara una vez y valida tests/lint/build más interacción con Chromium en el sandbox antes de emitir preview.ready. La plantilla declara controles visibles configurables y las dependencias npm se limitan a una allowlist exacta. La imagen `linux/amd64` se construyó localmente con Playwright 1.64.1 y la sonda Chromium pasó en Docker Desktop sin red; `npm run meta:smoke` también pasó con texto sintético. `ESTADO: PARCIAL`: falta conectar y validar creación/edición desde el Compose local. El runtime permanece apagado con `RUNS_ENABLED=false`; no se requiere publicar la imagen ni usar un host remoto. Ver [docs/generation.md](docs/generation.md).

Estado local de issue #21 (2 de noviembre de 2026): el worker guarda snapshots gzip privados con checksum/manifiesto, GameSpec, assets y reporte de verificación; excluye secretos y artefactos generados. El selector lista Latest/versiones y permite revisar cambios y checks; la restauración requiere ownership, lock/fencing de proyecto, verifica checksums y crea una versión nueva con rollback del workspace ante fallo. La reserva SQL precede al objeto S3 tanto en runs como en restores. Con `RUNS_ENABLED=true`, un reconciliador cada minuto verifica reservas `creating` de más de 30 minutos: recupera las que tienen un snapshot válido y marca fallidas las ausentes o corruptas mediante CAS; errores temporales de S3 se reintentan. `ESTADO: PARCIAL`: falta completar la preview histórica y validar el ciclo con sandbox/S3 dentro del Compose local. `RUNS_ENABLED=false` y el gateway siguen apagados por defecto. Ver [docs/versions.md](docs/versions.md).

Estado local de issue #22 (2 de noviembre de 2026): la publicación propia solo consume versiones ready verificadas y genera un artefacto estático aislado en un bucket S3 que permanece privado. La API usa la sesión PostgreSQL para identidad y ownership; el origen valida slug, publicación activa, manifiesto y hash de cada objeto, con caché pública de 60 segundos y cabeceras restrictivas. La revocación marca primero el registro como revoked para que las siguientes peticiones fallen y después borra los objetos. `npm run test:integration` verifica PostgreSQL/Redis/Silo local, solicitudes anónimas GET/HEAD, manifiesto, rechazo de `.env`/fuentes/mapas y revocación; B tampoco puede leer ni revocar la publicación de A. La comprobación local usa la misma credencial Silo root para worker/reader. `ESTADO: PARCIAL`: falta validar el build y la URL de `*.localhost` desde Compose; `PUBLISHING_ENABLED=false` por defecto hasta pasar esa prueba. No se requiere credencial S3 productiva ni DNS público.

Estado local de issue #23 (2 de noviembre de 2026): cuotas de proyectos y storage se reservan con lock por usuario; la UI muestra consumo y reservas de proyectos, concurrencia, tokens, imágenes y storage, con máximo de tiempo por run y errores de cuota traducidos. Cancelación después de crash reconcilia eventos durables, cobra tokens/imágenes medidos o ambiguos y libera el remanente; reintento mantiene la reserva. El worker adquiere leases de ciclo de vida, excluye runs, locks y sesiones vigentes de preview en Redis más su margen de expiración, captura/verifica snapshots antes de suspender y restaura contenido con comprobación de identidad/checksum antes de borrar el snapshot. El borrado de proyecto/cuenta revoca sesión/preview, conserva una tarea auditada, detiene el contenedor y mantiene el volumen hasta la retención antes de limpiar únicamente objetos, checkpoints, publicaciones y filas del proyecto. `npm run resources:reconcile` ejecuta una pasada. `ESTADO: PARCIAL`: falta validar cuotas y cleanup con el runtime/S3 locales dentro de Compose; `RESOURCE_LIFECYCLE_ENABLED=false` por defecto. Ver [docs/resource-lifecycle.md](docs/resource-lifecycle.md).

La reconciliación de limpieza de #23 elimina también los jobs de BullMQ usando las generaciones registradas en PostgreSQL; un job activo conserva su tarea para reintento.
La solicitud de borrado cancela el outbox de los runs en PostgreSQL; si una entrega ya encoló el job antes de perder su CAS, el worker lo retira de Redis.

Estado local de issue #24 (2 de noviembre de 2026): `npm run test:security:offline` ejecuta la matriz reproducible de sesiones propias, ownership, SSE, versiones, publicaciones, preview, cookies, CSRF, storage y políticas de egress/filesystem. `npm run test:security` agrega `tests/security/hostile-runtime.test.ts` para comprobar aislamiento, secretos, SSRF, DNS, carrera de symlinks, cuota, cgroups y timeout con dos sandboxes reales. La suite offline pasa (88 pruebas), igual que `npm test`, lint, typecheck e integración contra Postgres/Redis/Silo locales. `ESTADO: PARCIAL`: el runtime de prueba todavía exige daemon rootless con cgroups systemd; Docker Desktop disponible informa `cgroupfs`, y el daemon rootless anidado no aplica cgroups. Falta implementar/adaptar el perfil de runtime local y pasar estas pruebas dentro de Compose. Ver [docs/security-test-report.md](docs/security-test-report.md).
