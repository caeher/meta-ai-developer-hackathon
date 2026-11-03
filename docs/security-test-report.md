# Informe de pruebas de seguridad multiusuario

## Estado

`ESTADO: PARCIAL`. Las regresiones offline y las pruebas de integración con Postgres, Redis y Silo locales pasan. La suite hostil del runtime todavía no pasa en el Compose local: `npm run test:security` exige Linux y Docker rootless con cgroups v2/systemd; el daemon raíz de Docker Desktop informa `cgroupfs`, y el daemon rootless anidado inicia sin cgroups (`CgroupDriver=none`). La suite no debe ignorar esos checks ni afirmar que las cuotas están aplicadas.

El criterio pendiente es código local: integrar un runtime compatible con Docker Desktop, aislarlo dentro de Compose y probar cuotas/cgroups desde sandboxes reales. No se necesita un runner self-hosted ni un host dedicado. La suite hostil debe seguir fallando cerrada cuando falte un límite.

## Resultados verificados en este checkout

- Node `v24.22.1`.
- `npm run test:security:offline`: 13 archivos y 88 pruebas aprobadas.
- `npm test`: 36 archivos y 227 pruebas aprobadas; 10 archivos y 45 pruebas de integración se omitieron porque requieren servicios o flags explícitos.
- `npm run lint` y `npm run typecheck`: aprobados.
- `npm run infra:up`: Postgres, Redis y Silo locales quedaron saludables.
- `npm run infra:up -- --web --worker --local-domains`: los servicios base, web, worker y Caddy iniciaron; Postgres, Redis, Silo, Mailpit, web y Caddy reportaron healthy. El worker está en ejecución y no declara healthcheck.
- `npm run test:integration`: 9 archivos, 43 pruebas aprobadas y una omitida contra Postgres/Redis/Silo locales.
- `npm run infra:config`: Compose válido. `caddy validate` pasó y una petición HTTPS a `*.preview.localhost` completó TLS (`ssl_verify_result=0`); devolvió 502 porque el perfil del gateway estaba apagado durante esa comprobación.
- `npm run test:security`: las 88 regresiones offline pasan; la suite hostil no comienza en el proceso Windows y termina con `security_host_requires_linux`.
- Docker Desktop `29.9.2`: motor Linux, cgroup v2, driver `cgroupfs`, daemon principal no rootless. Un daemon `docker:dind-rootless` local inicia, pero reporta `CgroupDriver=none`; por tanto no aplica límites de CPU/memoria/PIDs.

## Matriz de regresión offline

| Área | Intento | Resultado esperado | Evidencia |
| --- | --- | --- | --- |
| Sesión y ownership | A, B y anónimo consultan/mutan recursos de A | 404 uniforme o denegación; ningún enqueue ajeno | `tests/projects-api.test.ts`, `tests/unit/run-handlers.test.ts`, `tests/unit/run-events-handler.test.ts`, `tests/versions-api.test.ts`, `tests/publications-api.test.ts` |
| Auth y CSRF | Sesión ausente/revocada, token de un uso repetido y origen ajeno | Denegación uniforme, CSRF rechazado y replay denegado | `tests/auth.test.ts`, `tests/integration/auth.test.ts` |
| Preview | Firma, grant, epoch, Host, path, cookies y WebSocket hostiles | Solo owner accede; revocación cierra sesión; no se filtran credenciales | `tests/integration/preview-gateway.test.ts`, `tests/preview-protocol.test.ts` |
| Egress/SSRF | IPv4/IPv6 privada, metadata, redirects, DNS rebinding y path encoding repetido | Rechazo; rutas registry exactas; DNS fijado a IPv4 pública | `tests/security/network.test.ts` |
| Filesystem | Traversal, rutas absolutas, symlinks y carrera al reemplazar directorios | Ninguna lectura/escritura fuera de `/workspace` | `tests/security/filesystem.test.ts` |
| Storage/publicación | Checksum/manifiesto, lectura anónima, owner ajeno y revocación | Objetos privados y publicación inmutable revocable | `tests/storage.test.ts`, `tests/publications-api.test.ts`, `tests/publishing-origin.test.ts`, `tests/integration/publications-s3.test.ts` |

## Matriz pendiente de runtime Docker local

La prueba existente `tests/security/hostile-runtime.test.ts` cubre dos sandboxes reales con payloads limitados:

- UID no root, rootfs read-only, capacidades vacías, ausencia de secretos y de socket Docker.
- Workspaces separados por owner, filesystem helper contra traversal y carrera de symlinks.
- Bloqueo de loopback, LAN, metadata, IPv6 y DNS directo; acceso solo al proxy npm.
- `npm install --ignore-scripts` con lifecycle hook hostil.
- Cuotas de disco y límites efectivos de CPU, memoria, PIDs y timeout, mientras el sandbox vecino sigue respondiendo.

No declarar esta matriz aprobada hasta ejecutarla en el perfil Compose local con límites que el motor aplique. No enviar prompts, tokens, cookies ni credenciales a logs.

## Comandos reproducibles

```sh
npm run infra:up -- --web --worker
npm run test:integration
npm run test:security:offline
npm run test:security
npm run infra:down
```

La parada conserva volúmenes. El reset completo se documenta en [desarrollo local](local-development.md) y borra los datos locales.
