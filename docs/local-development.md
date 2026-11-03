# Entorno interno Docker Compose

## Decisión de arquitectura

La aplicación es un monolito de producto en este repositorio. `infra/compose.yml` es el entorno interno de desarrollo, staging y aceptación; no se despliega a un VPS, servidor remoto ni host Linux dedicado. Docker Desktop con motor Linux es el destino local de contenedores. Postgres, Redis y Silo usan volúmenes Compose; no requieren servicios externos.

Las pruebas que históricamente mencionaban VPS, staging remoto, DNS/TLS wildcard, cuotas o rollback se ejecutan contra este entorno local. Los nombres de preview/publicación deben usar `*.localhost`; si una prueba necesita HTTPS, se usa TLS local autofirmado. El despliegue público final queda a cargo del propietario y no bloquea el estado de las issues.

## Requisitos

- Node.js `24.x` y npm.
- Docker Desktop con motor Linux activo y Docker Compose v2.
- Puertos `3000`, `5432`, `6379`, `9000` y `9001` disponibles. Los puertos de infraestructura se pueden cambiar en `infra/.env`. Para `--preview` o `--publishing`, también se necesita libre `127.0.0.1:443`.

## Levantar el entorno

Desde la raíz del repositorio:

```sh
npm ci
npm run infra:config
npm run infra:up -- --web --worker
```

El comando inicia Postgres, Redis, Silo, la aplicación web y el worker. La web queda en <http://localhost:3000>; la API de salud está en `/api/health`. El worker mantiene las features deshabilitadas según sus flags locales. Para levantar solo las dependencias de datos, ejecuta `npm run infra:up`.

`infra:config` valida Compose y la configuración sin mostrar valores. `infra:up` crea `infra/.env` desde `infra/env.example` si falta, crea los buckets privados y espera a que los healthchecks estén listos. El archivo local está ignorado por Git; no copies secretos al repositorio ni al chat.

Para revisar estado y configuración sin imprimir variables de entorno:

```sh
docker compose -f infra/compose.yml --env-file infra/.env ps
docker compose -f infra/compose.yml --env-file infra/.env config --quiet
```

## Dominios locales y HTTPS

Los perfiles de preview y publicación usan `preview.localhost` y `games.localhost`; el navegador resuelve esos nombres a loopback sin DNS externo. Al iniciar `--preview` o `--publishing`, `infra:up` agrega el perfil `local-domains`. El servicio Caddy publica HTTPS solo en `127.0.0.1:443`, termina TLS con su CA interna y enruta a los servicios privados del Compose. La CA y sus claves quedan en el volumen local `caddy-data`, nunca en Git.

Las funciones siguen apagadas por defecto. El gateway requiere `PREVIEW_GATEWAY_ENABLED=true` y claves RSA locales; el origen requiere `PUBLISHING_ENABLED=true` y runtime sandbox validado. Si `infra/.env` ya existía, `infra:up` conserva el archivo: cambia allí los dominios `PREVIEW_BASE_DOMAIN=preview.localhost` y `PUBLISH_BASE_DOMAIN=games.localhost` al habilitar esos perfiles. Para inspeccionar la CA raíz y, opcionalmente, confiarla en el almacén del usuario de Windows:

```powershell
$router = docker compose -f infra/compose.yml --env-file infra/.env ps --quiet local-router
docker cp "${router}:/data/caddy/pki/authorities/local/root.crt" "$env:TEMP\meta-ai-local-root.crt"
Import-Certificate -FilePath "$env:TEMP\meta-ai-local-root.crt" -CertStoreLocation Cert:\CurrentUser\Root
```

La importación es opcional y se revierte quitando ese certificado de `Cert:\CurrentUser\Root`. Si `infra:down --volumes` borra `caddy-data`, Caddy emite una CA nueva y hay que volver a confiarla.

## Migraciones y validación Docker local

Con los servicios activos, la base de datos se prepara y se verifica con:

```sh
npm run db:migrate
npm run db:seed
npm run test:integration
```

La suite de integración crea recursos temporales en Postgres, Redis y Silo locales, verifica ownership y almacenamiento privado, y limpia esos recursos al terminar. Los datos de seed son sintéticos.

La suite unitaria es `npm test`; la matriz de seguridad offline es `npm run test:security:offline`. `npm run test:security` construye y ejecuta el perfil Compose `security`, que prueba sandboxes Linux reales desechables, egress, filesystem, ownership, cgroups, cuotas y timeout. El runner temporal y de confianza es el único servicio con socket Docker; los sandboxes no reciben el socket ni secretos. El perfil prueba contenedores no root en Docker Desktop y no habilita `SANDBOX_DRIVER` para el producto, que permanece `disabled` hasta integrar el controlador y su modo de producción.

## Imágenes y almacenamiento

Compose fija Postgres, Redis, Silo y las imágenes Node por digest en `infra/compose.yml` y `infra/images.lock.json`. Silo ofrece la API S3 compatible que usan los tests de almacenamiento. Los buckets locales se crean privados.

La red de control permite egress para desarrollo. El código de juegos corre en sandboxes separados, con política egress propia; no se debe describir la red de control como aislamiento de sandbox. Cada issue que cambie runtime, cuotas, gateway u observabilidad debe añadir su servicio/configuración Compose y una prueba Docker local reproducible.

## Parada y persistencia

La parada normal conserva la base, Redis y objetos S3:

```sh
npm run infra:down
```

Para reiniciar, repite `npm run infra:up -- --web --worker`. El reset completo borra los volúmenes y es destructivo:

```sh
docker compose -f infra/compose.yml --env-file infra/.env down --volumes
```

## Alcance de la demo

Una issue queda `COMPLETA` cuando su código y checks aplicables, incluidas las pruebas Docker locales, pasan. Queda `PARCIAL` solo cuando falta código o falla una prueba, lint, typecheck o build. La publicación pública posterior no es un requisito pendiente del roadmap.
