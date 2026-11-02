# Forja — plataforma de juegos 2D

Forja es una plataforma en construcción para crear juegos web 2D mediante chat. El monorepo incluye una página inicial, un endpoint de liveness y servicios locales para desarrollar las siguientes entregas. Todavía no permite iniciar sesión, generar código o imágenes, ejecutar juegos, abrir previews privadas ni publicar.

## Requisitos

- Node.js `24.x` (`.nvmrc` y `engines.node` fijan `>=24 <25`).
- npm incluido con Node.js. El lockfile está versionado y las dependencias directas usan versiones exactas.
- Docker Engine con Docker Compose v2 para los servicios locales.

La aplicación mínima no necesita credenciales ni servicios externos para instalarse, arrancar o compilar. No copies `.env.example` sobre un `.env.local` existente: sus valores son placeholders. Docker Compose usa `infra/.env`, generado desde `infra/env.example`; ese archivo está excluido de Git.

## Inicio local

Desde PowerShell o una terminal Linux/macOS, en la raíz del repositorio:

```sh
node --version
npm ci
npm run dev
```

La versión de Node debe mostrar `v24.x`. Abre <http://localhost:3000>. Detén el servidor con `Ctrl+C`.

Para levantar las dependencias locales:

```sh
npm run infra:config
npm run infra:up
```

Postgres, Redis y S3 quedan ligados solo a loopback. `infra:up` prepara buckets privados y conserva los datos entre reinicios. Para agregar la app web en Compose usa `npm run infra:up -- --web`. Consulta [docs/local-development.md](docs/local-development.md) para puertos, persistencia, comprobaciones y reset explícito.

El endpoint `GET /api/health` solo comprueba que la app web responde. Devuelve `{"status":"ok","service":"web"}` sin consultar servicios externos ni serializar el entorno. No representa readiness de base de datos, cola, Meta o sandbox.

## Comandos disponibles

```sh
npm run dev
npm run infra:config
npm run infra:up
npm run infra:up -- --web
npm run infra:down
npm run db:migrate
npm run db:seed
npm run test:integration
npm run lint
npm run typecheck
npm test
npm run build
npm run start
npm run check:node
```

`npm ci` aplica `engine-strict`; también hay una comprobación explícita de Node 24 en la instalación y en los comandos de raíz. CI usa Node 24 y ejecuta instalación, lint, typecheck, tests y build sin claves.

## Persistencia y storage privado

La issue #3 incorpora el esquema Drizzle, migración inicial, seed sintético y adaptador S3 privado. Todavía no se habilitan Clerk, Meta, sandbox, gateway ni preview. `.env.example` contiene placeholders; no copies esos valores sobre un `.env.local` existente.

Con los servicios locales arriba, `npm run db:migrate` aplica las migraciones SQL de Drizzle y se puede repetir. El comando toma `DATABASE_URL` del entorno o deriva la conexión local desde `infra/.env`; no carga `.env.local`. `npm run db:seed` inserta dos usuarios, proyectos y actividad sintéticos; solo acepta PostgreSQL en loopback y es idempotente. No crea objetos S3 ficticios.

`npm run test:integration` crea una base temporal en PostgreSQL local y un bucket S3 privado temporal, aplica migraciones y verifica ownership, claves foráneas, paginación, idempotencia, ledger, sandboxes y storage. Requiere `npm run infra:up` y permiso local para crear/eliminar ambos recursos. Los elimina al finalizar.

El adaptador usa solo `S3_BUCKET_PRIVATE`, genera claves en servidor, admite objetos de hasta 25 MiB y valida SHA-256 al escribir y leer. El bucket privado de Silo no permite lectura anónima. El adaptador no emite URLs firmadas ni cambia ACLs a públicas. El proveedor de producción debe configurar bloqueo/política de acceso público antes de usarse.

Las migraciones no se revierten automáticamente. El archivo `0000_normal_chameleon_down.sql` es una operación destructiva manual; consulta [desarrollo local](docs/local-development.md) antes de ejecutarla. Las siguientes migraciones deben ser aditivas.

## Capacidades planificadas

Todavía no existen `dev:worker`, `dev:gateway`, smoke de Meta, pruebas E2E/seguridad, publicación o despliegue. Sus issues están enumeradas en [docs/ROADMAP.md](docs/ROADMAP.md). Clerk, Meta, sandbox rootless, gateway y preview privada se incorporarán en fases posteriores. No hay proveedor de IA ni ejecución de juegos habilitados.

## Estructura inicial

- `apps/web`: Next.js App Router, React, Radix Themes y TypeScript estricto.
- `packages/config`: validación de URLs públicas y configuración de infraestructura local.
- `packages/contracts`: schemas Zod de liveness y errores HTTP.
- `packages/db`: modelo PostgreSQL/Drizzle y repositorios que requieren identidad verificada.
- `packages/storage`: adaptador S3 privado con claves de servidor, checksum y estados de reconciliación.
- `infra`: Docker Compose, perfiles de desarrollo, ejemplos locales y digest de imágenes.
- `tests`: contratos y comportamiento de liveness con fixtures locales.
- `.github/workflows/ci.yml`: verificación en Node 24, sin secretos.

Phaser será el motor predeterminado para juegos generados según la arquitectura definida en [AGENTS.md](AGENTS.md); el runtime de juegos no se ejecuta dentro de Next.
