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
npm run lint
npm run typecheck
npm test
npm run build
npm run start
npm run check:node
```

`npm ci` aplica `engine-strict`; también hay una comprobación explícita de Node 24 en la instalación y en los comandos de raíz. CI usa Node 24 y ejecuta instalación, lint, typecheck, tests y build sin claves.

## Capacidades planificadas

Todavía no existen `dev:worker`, `dev:gateway`, migraciones/seed, smoke de Meta, pruebas de integración/E2E/seguridad, publicación o despliegue. Sus issues están enumeradas en [docs/ROADMAP.md](docs/ROADMAP.md). Clerk, Meta, el esquema de base de datos, sandbox rootless, gateway y preview privada se incorporarán en fases posteriores. No hay proveedor de IA ni ejecución de juegos habilitados.

`.env.example` documenta nombres y placeholders previstos; no contiene credenciales válidas. Los servicios locales de control no habilitan un sandbox. Silo es un fork compatible de MinIO para desarrollo: la edición comunitaria upstream archivó su repositorio y dejó de publicar imágenes comunitarias. No uses el storage local ni sus credenciales de ejemplo en producción.

## Estructura inicial

- `apps/web`: Next.js App Router, React, Radix Themes y TypeScript estricto.
- `packages/config`: validación de URLs públicas y configuración de infraestructura local.
- `packages/contracts`: schemas Zod de liveness y errores HTTP.
- `infra`: Docker Compose, perfiles de desarrollo, ejemplos locales y digest de imágenes.
- `tests`: contratos y comportamiento de liveness con fixtures locales.
- `.github/workflows/ci.yml`: verificación en Node 24, sin secretos.

Phaser será el motor predeterminado para juegos generados según la arquitectura definida en [AGENTS.md](AGENTS.md); el runtime de juegos no se ejecuta dentro de Next.
