# Informe de pruebas de seguridad multiusuario

## Estado

`ESTADO: COMPLETA` para la issue #24. La matriz offline y la suite hostil con contenedores Linux desechables pasan desde el perfil `security` de Docker Compose local. No se requiere VPS, servidor remoto, DNS público ni publicación.

La suite usa el motor Linux de Docker Desktop 29.9.2. El daemon informa cgroups v2 con driver `cgroupfs` y no es rootless; por eso el test explícito de aceptación usa el modo interno `docker-desktop-security`, UID no root, capacidades eliminadas, seccomp, rootfs de solo lectura, cgroups efectivos y workspace tmpfs acotado. Esto valida los límites del contenedor en Docker Desktop; no afirma que el daemon sea rootless ni que el controlador de producción esté integrado. `SANDBOX_DRIVER=disabled` sigue siendo el valor predeterminado hasta completar esa integración.

## Resultados de la issue

- `npm run test:security`: pasa la matriz offline (16 archivos, 101 pruebas) y el runtime hostil (8 pruebas) desde Compose.
- La suite real crea sandboxes A y B como contenedores separados, valida que no compartan workspace y destruye los recursos etiquetados al terminar.
- El runtime comprueba UID no root, rootfs, capabilities, seccomp, límites CPU/memoria/PIDs, cuota tmpfs, timeout, sockets/credenciales, aislamiento de red, DNS directo, SSRF IPv4/IPv6, proxy npm, carrera de symlinks e instalación sin lifecycle scripts.
- El egress proxy resuelve y fija IPv4 pública, valida respuestas/redirects y conserva el hostname TLS. La prueba Docker usa `registry.npmjs.org` permitido y bloquea destinos directos y hosts privados.
- Las pruebas offline cubren sesiones propias, ownership, SSE, versiones, publicaciones, preview, cookies, CSRF, storage y validación de egress/filesystem.

## Checks de aceptación ejecutados

- `npm run test:security`: 16 archivos/101 pruebas offline y 8 pruebas hostiles de Compose aprobadas.
- `npm test`: 36 archivos y 227 pruebas aprobadas; 10 archivos y 45 pruebas omitidas por requerir servicios o flags explícitos.
- `npm run test:integration`: 9 archivos/43 pruebas aprobadas y 1 prueba omitida con PostgreSQL, Redis y Silo locales.
- `npm run lint` y `npm run typecheck`: aprobados.
- `npm run build`, `npm run build:controller`, `npm run build:worker`, `npm run build:gateway` y `npm run build:publishing-origin`: aprobados.
- `docker compose --file infra/compose.yml --env-file infra/env.example --profile security config --quiet`: configuración válida.

## Matriz y evidencia

| Área | Intento | Resultado | Evidencia |
| --- | --- | --- | --- |
| Auth y ownership | Cuenta A, cuenta B, sesión ausente y recursos ajenos | No hay lectura, mutación ni enqueue cruzado | `tests/auth.test.ts`, `tests/projects-api.test.ts`, `tests/unit/run-handlers.test.ts`, `tests/worker-queue.test.ts` |
| Preview | Grants alterados/repetidos/expirados, epochs, origen, Host/path, cookies y WebSocket/HMR | Solo owner accede; la revocación cierra conexiones; no se filtran credenciales | `tests/integration/preview-gateway.test.ts`, `tests/preview-protocol.test.ts` |
| Egress y SSRF | Loopback, LAN, metadata, IPv4/IPv6, DNS directo, redirects y rebinding | Denegación salvo npm exacto a través del proxy | `tests/security/network.test.ts`, `tests/security/hostile-runtime.test.ts`, `infra/sandbox/egress-proxy.mjs` |
| Filesystem | Traversal, symlinks, carrera de directorios y enlaces | Sin escape de `/workspace` | `tests/security/filesystem.test.ts`, `tests/security/hostile-runtime.test.ts` |
| Sandbox real | Dos UID no root, rootfs, cgroups, cuota, lifecycle, timeout y memoria bajo presión | Límites efectivos; el vecino sigue operativo tras presión | `tests/security/hostile-runtime.test.ts`, `packages/sandbox/src/rootless.ts` |
| Storage/publicación | Ownership, integridad, lectura anónima, publicación y revocación | Objetos privados; publicación revocable | `tests/storage.test.ts`, `tests/publications-api.test.ts`, `tests/publishing-origin.test.ts` |

## Alcance y límites

El perfil `security` crea una imagen de prueba y un runner desechable. Solo el runner de confianza monta `/var/run/docker.sock`; su red está desactivada. Los sandboxes no reciben socket, credenciales ni acceso al control plane. El modo tmpfs prueba una cuota real de workspace en Docker Desktop. La cuota por volumen del modo rootless de producción y la integración del controlador siguen pendientes en sus issues y continúan apagadas por defecto; no son requisitos para cerrar la matriz de pruebas #24.

El host comparte el kernel Linux de Docker Desktop. La suite confirma restricciones de los contenedores y de la red dentro de ese motor local, no aislamiento de un daemon rootless ni despliegue público.

## Comandos reproducibles

```sh
npm run test:security:offline
npm run test:security
npm test
npm run infra:up
npm run test:integration
npm run infra:down
```

`npm run test:security` construye y ejecuta el perfil Compose `security`; no requiere copiar secretos ni iniciar servicios de producto. `infra:down` conserva los volúmenes locales.
