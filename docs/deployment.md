# Despliegue interno con Docker Compose (#27)

## Destino

`infra/compose.yml` es el staging y la aceptación internos del producto. Se ejecuta en Docker Desktop con motor Linux; no configura VPS, DNS público ni certificados wildcard públicos. La aplicación usa `app.localhost`; preview y publicación usan `*.preview.localhost` y `*.games.localhost`. Caddy emite certificados locales y liga HTTPS a loopback.

## Aceptación reproducible

En Node 24, con Docker Desktop iniciado y `npm ci` completado:

```powershell
npm run infra:up -- --acceptance
docker compose --file infra/compose.yml --env-file infra/env.example ps
```

El flujo de aceptación toma los valores locales de `infra/env.example`, construye el sandbox con la base Node fijada, fija su ID de contenido SHA-256 para esa ejecución y habilita el perfil local de controlador. Genera claves RSA, AUTH y tokens aleatorios en memoria; no los guarda en archivos ni los imprime. Migra la base y consulta las rutas HTTPS de app, preview y publicación antes de terminar. No carga `.env.local` ni envía solicitudes a Meta.

La aceptación activa el editor, el gateway, el origen de publicación y el controlador. `RUNS_ENABLED=false`; no crea runs ni consume la clave de Meta. El gateway y el origen deben responder desde Compose, mientras que una preview o publicación concreta sigue requiriendo un proyecto/versión privada verificada. El flujo de producción conserva flags apagados por defecto.

Verificación manual opcional de certificados y editor, ignorando solo la CA autofirmada en esta petición local:

```powershell
curl.exe --resolve app.localhost:443:127.0.0.1 --insecure https://app.localhost/api/health/readyz
```

Para el navegador, instala la CA local de Caddy siguiendo [desarrollo local](local-development.md#dominios-locales-y-https). La CA se guarda en el volumen `caddy-data`, no en el repositorio.

## Runtime y fronteras

El servicio `sandbox-controller` pertenece al perfil `runtime`. Es el único servicio de producto que monta `/var/run/docker.sock`; no publica puertos al host y solo worker conoce su URL y token. Compose limita el controlador con rootfs de solo lectura, `no-new-privileges`, capabilities eliminadas, PID limit y filesystem temporal acotado. Los puertos de PostgreSQL, Redis, Silo, web y Caddy se enlazan a loopback.

En la aceptación de Docker Desktop el daemon es rootful. El controlador exige Docker Desktop, Engine 28+, cgroups v2/cgroupfs y `SANDBOX_HOST_RUNTIME_MODE=docker-desktop-security` con workspace `tmpfs` acotado. El contenedor del juego usa UID no root, sin capabilities, rootfs de solo lectura, cgroups, red aislada y proxy npm permitido. Este modo valida el entorno local; no afirma que el daemon sea rootless ni sustituye el preflight de un daemon rootless systemd con cuotas de volumen.

El proxy Caddy enruta SSE con `flush_interval -1`; las conexiones WebSocket se pasan al gateway. Los endpoints de métricas/readiness de servicios permanecen en la red interna. Los logs usan campos allowlisted y rotación acotada; la exportación OTLP está vacía por defecto.

## Secretos y servicios externos

Los ejemplos contienen únicamente placeholders. La aceptación crea credenciales efímeras locales y no lee credenciales de `.env.local`. Para desarrollo cotidiano, `infra:up` puede crear `infra/.env` desde el ejemplo; no publiques ese archivo. Las claves de Meta y del mailer solo se inyectan en los servicios autorizados cuando el operador habilita esos flujos. `RUNS_ENABLED` permanece apagado hasta que Meta, sandbox y cuota se configuren para esa ejecución.

Las políticas Contributor, mayoría de edad y datos no confidenciales siguen aplicándose antes de cada envío. No se ejecutó un smoke facturable real de Meta en #27. El envío de correo real, los dominios públicos y TLS público pertenecen al operador y quedan fuera del staging local.

## Revisión de salud

La aceptación usa healthchecks de Compose y valida `/api/health/readyz` por Caddy. Los servicios internos exponen `/livez`, `/readyz` y `/metrics` solo dentro de Compose; la web expone `/api/health/livez`, `/api/health/readyz` y `/api/metrics`. Revisa el estado sin volcar variables de entorno:

```powershell
docker compose --file infra/compose.yml --env-file infra/env.example ps
docker compose --file infra/compose.yml --env-file infra/env.example logs --tail 100 web worker sandbox-controller preview-gateway publishing-origin local-router
```

## Apagado

```powershell
npm run infra:down
```

La parada normal conserva los volúmenes de Postgres, Redis, Silo y la CA de Caddy. Para volver a ejecutar la aceptación, repite `npm run infra:up -- --acceptance`; sus claves efímeras rotan y las sesiones anteriores dejan de servir.
