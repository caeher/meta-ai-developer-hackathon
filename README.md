# Forja — plataforma de juegos 2D

Forja es una plataforma en construcción para crear juegos web 2D mediante chat. Esta primera entrega deja operativo el monorepo, una página inicial y el endpoint de liveness. Todavía no permite iniciar sesión, generar código o imágenes, ejecutar juegos, abrir previews privadas ni publicar.

## Requisitos

- Node.js `24.x` (`.nvmrc` y `engines.node` fijan `>=24 <25`).
- npm incluido con Node.js. El lockfile está versionado y las dependencias directas usan versiones exactas.

El proyecto no necesita credenciales ni servicios externos para instalarse, arrancar o compilar. No copies `.env.example` sobre un `.env.local` existente: todos sus valores son placeholders y las variables todavía no son consumidas por esta app mínima.

## Inicio local

Desde PowerShell o una terminal Linux/macOS, en la raíz del repositorio:

```sh
node --version
npm ci
npm run dev
```

La versión de Node debe mostrar `v24.x`. Abre <http://localhost:3000>. Detén el servidor con `Ctrl+C`.

El endpoint `GET /api/health` solo comprueba que la app web responde. Devuelve `{"status":"ok","service":"web"}` sin consultar servicios externos ni serializar el entorno. No representa readiness de base de datos, cola, Meta o sandbox.

## Comandos disponibles

```sh
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm run start
npm run check:node
```

`npm ci` aplica `engine-strict`; también hay una comprobación explícita de Node 24 en la instalación y en los comandos de raíz. CI usa Node 24 y ejecuta instalación, lint, typecheck, tests y build sin claves.

## Capacidades planificadas

Los comandos siguientes aún no existen y no deben considerarse operativos: `dev:worker`, `dev:gateway`, Docker Compose, migraciones/seed, smoke de Meta, pruebas de integración/E2E/seguridad, publicación y despliegue. Sus issues están enumeradas en [docs/ROADMAP.md](docs/ROADMAP.md). Clerk, Meta, Postgres, Redis, S3/MinIO, sandbox rootless, gateway y preview privada se incorporarán en fases posteriores. No hay proveedor, mock de producción ni ejecución de juegos habilitados en esta entrega.

`.env.example` documenta nombres y placeholders previstos para esas fases. No contiene credenciales válidas. La página inicial no carga ese archivo y `/api/health` no lee variables de entorno.

## Estructura inicial

- `apps/web`: Next.js App Router, React, Radix Themes y TypeScript estricto.
- `packages/config`: validación limitada a URLs públicas de la app.
- `packages/contracts`: schemas Zod de liveness y errores HTTP.
- `tests`: contratos y comportamiento de liveness con fixtures locales.
- `.github/workflows/ci.yml`: verificación en Node 24, sin secretos.

Phaser será el motor predeterminado para juegos generados según la arquitectura definida en [AGENTS.md](AGENTS.md); el runtime de juegos no se ejecuta dentro de Next.
