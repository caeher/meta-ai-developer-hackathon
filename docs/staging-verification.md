# Verificación del staging interno (#27)

## Entorno

- Docker Desktop 29.9.2, motor Linux, Engine 29.9.2, cgroups v2/cgroupfs.
- Docker Compose 5.6.1.
- Node.js 24.x y dependencias del `package-lock.json`.
- `infra/compose.yml`, Silo local, Caddy con CA local y dominios `.localhost`.
- Los runs de Meta permanecen apagados. No se leen `.env.local` ni se realizan llamadas facturables.

## Comandos de aceptación

```powershell
$env:LOCAL_INFRA_ENV = 'example'
npm run infra:config
npm run infra:up -- --acceptance
docker compose --file infra/compose.yml --env-file infra/env.example ps
curl.exe --resolve app.localhost:443:127.0.0.1 --insecure https://app.localhost/api/health/readyz
npm run test:security
npm run test:integration
npm run test:e2e
$env:DOTENV_CONFIG_PATH = (Join-Path (Get-Location) '.env.example')
npm run backup:acceptance
Remove-Item Env:DOTENV_CONFIG_PATH
npm run lint
npm run typecheck
npm run build:worker
npm run build:controller
npm run build:gateway
npm run build:publishing-origin
npm run build:game-template
docker compose --file infra/compose.yml --env-file infra/env.example --profile web run --rm --no-deps --entrypoint npm web run build --workspace @meta-game/web
```

El comando `infra:up --acceptance` usa el ejemplo versionado, crea tokens/claves aleatorios solo en memoria, construye el sandbox local y valida readiness/HTTPS de editor, gateway y origen. El perfil `security` ejecuta pruebas hostiles Linux desechables. `test:integration` crea bases y buckets temporales; E2E usa fixtures y no reemplaza una generación real de Meta.

## Matriz que debe pasar

| Área | Evidencia | Criterio |
| --- | --- | --- |
| Imágenes y Compose | `docker compose ... config --quiet` y builds del workflow CI | imágenes con Node 24 fijado; ninguna clave en args ni bundle |
| HTTPS local | acceptance + Caddy en `127.0.0.1:443` | editor 200; rutas privadas/desconocidas no dan acceso anónimo |
| Runtime | healthcheck del controlador y `npm run test:security` | UID no root, `tmpfs` acotado, cgroups, timeout, PIDs, red/egress y proxy verificados |
| Multiusuario | `npm run test:integration` y suites de ownership | B no puede leer, cambiar, publicar ni restaurar recursos de A |
| Streams y gateway | `npm run test:e2e` + contratos del gateway | reconexión SSE, replay, WebSocket y cabeceras seguras |
| Persistencia y rollback | `npm run backup:acceptance` | datos Postgres/Silo recuperados en destinos vacíos |
| Calidad | lint, typecheck, tests y builds | comandos completan con exit code 0 |

## Límites

## Resultado observado (3 de noviembre de 2026)

- `npm run infra:up -- --acceptance`: exit 0; Postgres, Redis, Silo, Mailpit, web, worker, controlador, gateway, origen de publicación y Caddy quedaron saludables. La ruta HTTPS de app respondió 200; un host preview no autorizado y un host de juego desconocido respondieron 404.
- `npm run test:security`: 105 pruebas offline y 8 pruebas hostiles con Docker Desktop; UID no root, aislamiento A/B, SSRF, symlink, lifecycle, límites cgroups/CPU/memoria/PIDs, cuota tmpfs y timeout pasaron.
- `npm test`: 304 pasaron y 55 skips; `npm run test:integration`: 54 pasaron y 1 skip; `npm run test:e2e`: 72/72 en Chromium, Firefox y WebKit.
- `npm run backup:acceptance`: correcto; backup 4.581 s, restore 2.273 s, total 7.382 s, con una base, dos buckets y objetos sintéticos temporales.
- `npm run lint`, `npm run typecheck`, builds de worker/controlador/gateway/origen/Phaser y `next build` dentro de la imagen web: exit 0. Phaser reportó solo el aviso existente de chunk mayor a 500 KiB.

El modo local prueba contenedores en el daemon rootful de Docker Desktop, con UID no root y límites verificados. No prueba un daemon rootless Linux ni cuotas de volumen XFS/ext4. El controlador de Compose es el único contenedor con socket Docker y no publica puerto. La integración SMTP real, las solicitudes facturables a Meta y la publicación pública quedan fuera; se usan Mailpit, fixtures y `*.localhost` dentro de Compose. No se cargó `.env.local`, no se hizo smoke facturable de Meta y las credenciales de aceptación se generaron en memoria.
