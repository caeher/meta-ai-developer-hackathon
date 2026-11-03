# ADR 0004: controlador privado y sandboxes locales

Estado: aceptada para Docker Compose local; `ESTADO: PARCIAL` hasta integrar el runtime y pasar sus pruebas Docker en esta máquina.

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

El kernel sigue siendo el de Docker Desktop; esta arquitectura valida el producto en el entorno local elegido y no pretende probar un despliegue público. Docker Desktop 29.9.2 disponible informa `cgroupfs`, no modo rootless. Un daemon rootless anidado inicia, pero informa `CgroupDriver=none`, por lo que ignora límites cgroup; esa configuración no pasa el preflight actual. Falta el perfil Compose que aplique y pruebe recursos/cuotas en el runtime local. Hasta entonces `SANDBOX_DRIVER=disabled` y las funciones que dependen del sandbox permanecen apagadas.

La verificación se ejecuta con los comandos Docker-local registrados en [desarrollo local](../local-development.md) y [el informe de seguridad](../security-test-report.md). No se necesita ni se crea un host remoto.

## Reversión

Detener el perfil local, respaldar Postgres si se conservarán sus datos y retirar solo recursos etiquetados `com.meta-game.managed=true`. `npm run infra:down` conserva volúmenes; el borrado total requiere el reset explícito de [desarrollo local](../local-development.md).
