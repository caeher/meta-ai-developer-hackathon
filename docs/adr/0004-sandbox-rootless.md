# ADR 0004: controlador privado y sandboxes locales

Estado: aceptada para Docker Compose local; la matriz hostil de #24 pasa en Docker Desktop. `ESTADO: PARCIAL` para la integración del controlador/driver rootless de producción.

## Contexto

Los juegos y comandos son código no confiable. Ni Next ni el worker de confianza deben acceder directamente al runtime. El propietario decidió que no hay VPS, staging remoto ni host Linux dedicado: el entorno de aceptación es Docker Desktop con motor Linux y Compose en este repositorio.

## Decisión

- Ejecutar `apps/sandbox-controller` y los servicios de control dentro del Compose local. El controlador resuelve owner/proyecto en PostgreSQL; el worker lo llama con Bearer. Web, worker y juegos no reciben el socket del runtime.
- Solo el contenedor de controlador de confianza puede montar el socket del runtime local. No publicar el daemon por TCP ni dar acceso al socket a proyectos o procesos de generación. Mantener el controlador en la red privada de Compose.
- Crear un sandbox y una red privada por proyecto con UID interior único, rootfs de solo lectura, `CapDrop=ALL`, `no-new-privileges`, seccomp, namespaces privados y cero puertos publicados. Solo el proxy interno confiable puede alcanzar el registro npm permitido; el sandbox no tiene egress directo.
- Aplicar límites de CPU, memoria, PIDs, tiempo y disco mediante controles que el runtime Docker local realmente aplique. El preflight debe inspeccionar cgroups y llenar el workspace para comprobar `ENOSPC`; cualquier límite que no se aplique hace fallar el arranque y deja `SANDBOX_DRIVER=disabled`.
- Mantener TTL, leases y reaper persistidos en PostgreSQL. La pausa/destrucción captura un snapshot verificable antes de retirar el workspace, según #21 y #23.
- No marcar la ejecución como completa con tests de driver falso. La matriz hostil corre contra sandboxes desechables creados por el Compose local.

## Consecuencias y validación

El kernel sigue siendo el de Docker Desktop. La suite `npm run test:security` pasa en el perfil Compose local: el runner de confianza valida sandboxes de UID no root, rootfs read-only, capabilities/seccomp, cgroups, cuota tmpfs, egress y aislamiento hostil. El daemon Docker Desktop 29.9.2 es rootful y usa `cgroupfs`; un daemon rootless anidado informa `CgroupDriver=none` y no aplica límites cgroup. Por eso la suite tiene un modo interno de aceptación que comprueba límites reales de contenedores en el motor local sin afirmar que el daemon sea rootless.

Desde #27 el perfil `runtime` de Compose integra el controlador al producto y la aceptación local pasa; la ejecución sigue deshabilitada por defecto. `SANDBOX_DRIVER=disabled` y las funciones dependientes siguen apagadas por defecto; en Docker Desktop la cuota de workspace se aplica con tmpfs acotado (modo interno de aceptación), no con cuota de volumen XFS/ext4, y el daemon local es rootful: no se afirma aislamiento rootless. Consulta [desarrollo local](../local-development.md) y [el informe de seguridad](../security-test-report.md).
## Reversión

Detener el perfil local, respaldar Postgres si se conservarán sus datos y retirar solo recursos etiquetados `com.meta-game.managed=true`. `npm run infra:down` conserva volúmenes; el borrado total requiere el reset explícito de [desarrollo local](../local-development.md).
