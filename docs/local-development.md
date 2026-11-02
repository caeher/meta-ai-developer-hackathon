# Desarrollo local

## Requisitos

- Node.js `24.x` y npm para los comandos del repositorio.
- Docker Engine y el plugin Docker Compose v2. En Windows se admite Docker Desktop con integración WSL2 habilitada para la distribución usada.
- Puertos locales disponibles: `3000`, `5432`, `6379`, `9000` y `9001`. Se pueden cambiar los puertos de infraestructura en `infra/.env`.

Compose es solo para servicios de control y desarrollo. No ejecuta juegos generados, no ofrece un sandbox y no monta el socket Docker. El controlador rootless futuro correrá en un host Linux dedicado fuera de los contenedores de la app y el worker.

## Configuración e inicio

Desde la raíz:

```sh
npm ci
npm run infra:config
npm run infra:up
```

La primera ejecución crea `infra/.env` desde `infra/env.example`. El archivo contiene credenciales locales de ejemplo, queda ignorado por Git y no se copia a `.env.local`. Puedes editar sus puertos, nombres de buckets y credenciales antes de iniciar los servicios. El validador solo acepta valores de un formato local portable y reporta nombres de variables inválidas, nunca sus valores.

El perfil `web` utiliza la entrada Next.js ya existente y recibe solo `APP_ORIGIN`, `NEXT_PUBLIC_APP_URL` y `NEXT_TELEMETRY_DISABLED`. Para iniciarlo junto con las dependencias:

```sh
npm run infra:up -- --web
```

Worker y gateway no tienen perfiles Compose porque todavía no existen sus entrypoints. No se reportan como servicios saludables.

La configuración Compose directa también se puede revisar con:

```sh
docker compose -f infra/compose.yml config
docker compose -f infra/compose.yml --env-file infra/.env ps
```

Los servicios publicados en el host enlazan `127.0.0.1`. La red bridge de desarrollo permite egress de los contenedores de control; no ejecuta código de juegos ni constituye la política de egress del sandbox. Los puertos de datos no se publican en perfiles de despliegue. Web no recibe claves de Clerk, Meta o del controlador.

## Servicios e imágenes

Postgres 17.11, Redis 8.10.2 y el storage S3 local están fijados por digest en `infra/compose.yml` y registrados en `infra/images.lock.json`. PostgreSQL usa su volumen administrado; Redis persiste AOF; storage conserva objetos en otro volumen. Los healthchecks prueban readiness específica del proceso.

MinIO archivó su repositorio comunitario el 25 de abril de 2026 y dejó de distribuir imágenes comunitarias mantenidas. La imagen comunitaria oficial no está disponible para descarga anónima y Docker Hardened Images requiere un derecho ELS para MinIO. Para que el entorno siga ejecutable, Compose usa **Silo**, fork mantenido que conserva las interfaces S3 y las variables de configuración `MINIO_*`. Es una sustitución local transparente para la API S3 seleccionada, no una imagen oficial de MinIO. Revisar compatibilidad con los flujos concretos antes de cambiar el proveedor y no asumir soporte comercial ni garantía upstream.

`infra:up` crea los buckets configurados y fija acceso anónimo `none` en ambos. Puede verificarse que no haya lectura anónima (la respuesta debe ser `403`):

```sh
curl -i http://127.0.0.1:9000/meta-game-private
curl -i http://127.0.0.1:9000/meta-game-public
```

Si cambiaste los nombres de bucket, usa los valores de `infra/.env`. Para ver readiness y servicios:

```sh
docker compose -f infra/compose.yml --env-file infra/.env ps
```

## Parada, persistencia y reset

La parada normal conserva datos:

```sh
npm run infra:down
```

Los volúmenes administrados no se borran al detener los contenedores ni al ejecutar `down`. Para comprobar persistencia, sube servicios, escribe un objeto de prueba con un cliente S3, ejecuta `infra:down`, vuelve a iniciar y lee el mismo objeto.

El borrado completo es destructivo y explícito; detén primero los servicios y ejecuta solo si aceptas perder la base, Redis, buckets y cachés locales:

```sh
docker compose -f infra/compose.yml --env-file infra/.env down --volumes
```

Después, `npm run infra:up` crea de nuevo los volúmenes y los buckets vacíos. No ejecutes el reset contra datos que quieras conservar.

## Límites

- Los valores del ejemplo son únicamente locales. Usa credenciales únicas si necesitas exponer el entorno dentro de una LAN; los puertos están intencionalmente restringidos a loopback.
- El servicio S3 compatible local no sustituye una decisión de almacenamiento para producción.
- La red bridge local no restringe el egress de los servicios de control; el futuro sandbox necesitará su propia política de salida comprobada desde código arbitrario.
- Las pruebas de escape, SSRF y aislamiento multiusuario requieren el runner Linux desechable de seguridad; no se ejecutan en este Compose ni en una máquina personal.
