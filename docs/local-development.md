# Desarrollo local

## Requisitos

- Node.js `24.x` y npm para los comandos del repositorio.
- Docker Engine y el plugin Docker Compose v2. En Windows se admite Docker Desktop con integración WSL2 habilitada para la distribución usada.
- Puertos locales disponibles: `3000`, `5432`, `6379`, `9000` y `9001`. Se pueden cambiar los puertos de infraestructura en `infra/.env`.

Compose es solo para servicios de control y desarrollo. No ejecuta juegos, no monta el socket Docker y no incluye el controlador rootless. apps/sandbox-controller corre nativamente en un host Linux dedicado, fuera de web y worker. Docker Desktop con WSL2 no sustituye ese host.

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

El worker tiene perfil Compose desde #11; recibe solo URL y token placeholder del controlador, nunca el socket Docker. El gateway de preview sigue pendiente.

La configuración Compose directa también se puede revisar con:

```sh
docker compose -f infra/compose.yml config
docker compose -f infra/compose.yml --env-file infra/.env ps
```

## Persistencia local

Con Postgres y Silo disponibles, aplica la migración y carga los fixtures sintéticos:

```sh
npm run db:migrate
npm run db:seed
```

`db:migrate` usa `DATABASE_URL` del entorno si está definido. Si falta, arma la URL de loopback con las variables de `infra/.env`; nunca lee `.env.local`. Drizzle registra cada migración aplicada, por lo que volver a ejecutar el comando no repite ni altera una migración anterior.

`db:seed` requiere PostgreSQL local en loopback y rechaza `NODE_ENV=production`. Inserta dos identidades autenticación propia sintéticas, proyectos, mensajes, runs, eventos, sandboxes y registros de uso con IDs reservados. Repetir el comando no duplica fixtures. No genera datos personales ni pretende autenticar a esas identidades.

Las pruebas integradas usan una base y un bucket privados temporales:

```sh
npm run test:integration
```

El comando necesita permiso para crear/eliminar una base y un bucket en los servicios locales. Migra la base temporal desde cero, repite la migración, aplica el seed sintético dos veces y compara sus filas, verifica consultas de dos dueños y lectura S3 anónima, y elimina la base y el bucket temporal al finalizar. No configura ni contacta un PostgreSQL o bucket remoto.

La primera migración puede revertirse solo de forma manual en una base local descartable. Detén la aplicación y ejecuta desde la raíz:

```sh
# PowerShell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/migrations/0000_normal_chameleon_down.sql

# Linux/macOS
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/migrations/0000_normal_chameleon_down.sql
```

El archivo elimina todas las tablas y tipos de esta migración, incluidos sus datos. No lo ejecutes en staging ni producción. `0001_dazzling_red_skull_down.sql` cambia los UUID del ledger a una secuencia nueva; los IDs/cursors externos no se conservan, así que usa un backup si los necesitas. No hay rollback automático de migraciones futuras; cada cambio posterior debe ser aditivo y tener un plan explícito.

Los servicios publicados en el host enlazan `127.0.0.1`. La red bridge de desarrollo permite egress de los contenedores de control; no ejecuta código de juegos ni constituye la política de egress del sandbox. Los puertos de datos no se publican en perfiles de despliegue. Web no recibe claves de autenticación propia, Meta o del controlador.

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
